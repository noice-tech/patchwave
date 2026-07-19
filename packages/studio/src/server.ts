import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { parseStudioInput } from "./protocol-validate.js";
import type { StudioInput, StudioServerMessage } from "./protocol.js";
export type { StudioInput } from "./protocol.js";

const MAX_CLIENT_MESSAGE_BYTES = 4_096;
const MAX_BUFFERED_BYTES = 65_536;
const STATE_PUBLISH_INTERVAL_MS = 40;
export type StudioServerOptions = {
  onInput: (input: StudioInput) => void | StudioServerMessage | Promise<void | StudioServerMessage>;
  onControllerClosed: () => void;
  getState: () => unknown;
};

export type StudioServer = {
  url: string;
  publish(state: unknown): void;
  send(message: StudioServerMessage): void;
  disconnect(): void;
  close(): Promise<void>;
};

type StudioAsset = Readonly<{ type: string; url: URL }>;

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const assets = await loadStudioAssets();
  const token = randomBytes(24).toString("base64url");
  const basePath = `/session/${token}/`;
  let expectedHost = "";
  let expectedOrigin = "";
  let controller: WebSocket | undefined;
  let controllerReleased = true;
  let pendingState: unknown;
  let hasPendingState = false;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelPendingPublish = (): void => {
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    publishTimer = undefined;
    pendingState = undefined;
    hasPendingState = false;
  };
  const releaseController = (socket: WebSocket): void => {
    if (controller !== socket || controllerReleased) return;
    controllerReleased = true;
    controller = undefined;
    cancelPendingPublish();
    try {
      options.onControllerClosed();
    } catch {
      // Controller authority and safety cleanup must remain fail-closed even if a host callback errs.
    }
  };
  const failSocket = (socket: WebSocket): void => {
    releaseController(socket);
    try {
      socket.terminate();
    } catch {
      // Already closed.
    }
  };
  const flushState = (): void => {
    publishTimer = undefined;
    const state = pendingState;
    const shouldPublish = hasPendingState;
    pendingState = undefined;
    hasPendingState = false;
    const socket = controller;
    if (!socket || socket.readyState !== WebSocket.OPEN || !shouldPublish) return;
    if (!sendGuarded(socket, { type: "state", state }, MAX_BUFFERED_BYTES)) failSocket(socket);
  };

  const server = createServer((request, response) => {
    void handleHttp(request, response, expectedHost, basePath, assets);
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    if (
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      request.headers.origin !== expectedOrigin ||
      request.url !== `${basePath}socket` ||
      controller !== undefined
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      controller = webSocket;
      controllerReleased = false;
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (controller !== socket || controllerReleased) {
        socket.terminate();
        return;
      }
      const byteLength = Array.isArray(data)
        ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
        : data.byteLength;
      if (isBinary || byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        releaseController(socket);
        socket.terminate();
        return;
      }
      const input = parseStudioInput(data.toString());
      if (!input) {
        releaseController(socket);
        socket.terminate();
        return;
      }
      let result: ReturnType<StudioServerOptions["onInput"]>;
      try {
        result = options.onInput(input);
      } catch {
        failSocket(socket);
        return;
      }
      void Promise.resolve(result)
        .then((message) => {
          if (!message || controller !== socket || controllerReleased) return;
          if (!sendGuarded(socket, message, MAX_BUFFERED_BYTES)) failSocket(socket);
        })
        .catch(() => failSocket(socket));
    });
    socket.on("close", () => releaseController(socket));
    socket.on("error", () => releaseController(socket));
    try {
      if (!sendGuarded(socket, { type: "state", state: options.getState() }, MAX_BUFFERED_BYTES))
        failSocket(socket);
    } catch {
      failSocket(socket);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Studio server did not receive a TCP address");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const url = `${expectedOrigin}${basePath}`;

  return {
    url,
    publish(state: unknown): void {
      const socket = controller;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      pendingState = state;
      hasPendingState = true;
      publishTimer ??= setTimeout(flushState, STATE_PUBLISH_INTERVAL_MS);
    },
    send(message: StudioServerMessage): void {
      const socket = controller;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!sendGuarded(socket, message, MAX_BUFFERED_BYTES)) failSocket(socket);
    },
    disconnect(): void {
      const socket = controller;
      if (!socket) return;
      releaseController(socket);
      try {
        socket.close(1008, "Session reset");
      } catch {
        failSocket(socket);
      }
    },
    async close(): Promise<void> {
      const socket = controller;
      if (socket) {
        releaseController(socket);
        try {
          socket.close(1001, "Server shutting down");
        } catch {
          failSocket(socket);
        }
      } else {
        cancelPendingPublish();
      }
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
      await closeHttpServer(server);
    },
  };
}

async function loadStudioAssets(): Promise<ReadonlyMap<string, StudioAsset>> {
  const root = new URL("../dist/client/", import.meta.url);
  const manifestValue: unknown = JSON.parse(
    await readFile(new URL(".vite/manifest.json", root), "utf8"),
  );
  if (!isRecord(manifestValue)) throw new Error("Studio Vite manifest is invalid");
  const allowed = new Set<string>(["index.html"]);
  for (const entry of Object.values(manifestValue)) {
    if (!isRecord(entry) || typeof entry.file !== "string")
      throw new Error("Studio Vite manifest entry is invalid");
    allowed.add(validAssetPath(entry.file));
    for (const key of ["css", "assets"] as const) {
      const values = entry[key];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
        throw new Error("Studio Vite manifest asset list is invalid");
      for (const value of values as string[]) allowed.add(validAssetPath(value));
    }
  }
  const assets = new Map<string, StudioAsset>();
  for (const relative of allowed) {
    const url = new URL(relative, root);
    await readFile(url);
    assets.set(relative, { type: assetType(relative), url });
  }
  return assets;
}

function validAssetPath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error("Studio Vite manifest contains an unsafe asset path");
  return path;
}

function assetType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  basePath: string,
  assets: ReadonlyMap<string, StudioAsset>,
): Promise<void> {
  setSecurityHeaders(response);
  if (request.method !== "GET" || request.headers.host !== expectedHost) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const isIndex = request.url === basePath;
  const relative = isIndex ? "index.html" : request.url?.slice(basePath.length);
  const expectedUrl = isIndex ? basePath : `${basePath}${relative ?? ""}`;
  if (!relative || !assets.has(relative) || request.url !== expectedUrl) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const asset = assets.get(relative)!;
    const body = await readFile(asset.url);
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(500).end("Studio asset unavailable");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), midi=()");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendGuarded(socket: WebSocket, message: StudioServerMessage, maxBytes: number): boolean {
  try {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(message);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > maxBytes || socket.bufferedAmount + bytes > maxBytes) return false;
    socket.send(serialized);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
