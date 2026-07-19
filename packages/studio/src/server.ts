import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { NOTE_CODES } from "./keyboard-state.js";

const MAX_CLIENT_MESSAGE_BYTES = 4_096;
const MAX_BUFFERED_BYTES = 65_536;
const STATE_PUBLISH_INTERVAL_MS = 40;
const INPUT_CODES = new Set([...Object.keys(NOTE_CODES), "KeyZ", "KeyX"]);

export type StudioInput =
  | Readonly<{ type: "keyDown" | "keyUp"; code: string }>
  | Readonly<{ type: "releaseAll" }>;

export type StudioServerOptions = {
  onInput: (input: StudioInput) => void;
  onControllerClosed: () => void;
  getState: () => unknown;
};

export type StudioServer = {
  url: string;
  publish(state: unknown): void;
  disconnect(): void;
  close(): Promise<void>;
};

const ASSETS = {
  "index.html": {
    type: "text/html; charset=utf-8",
    url: new URL("../public/index.html", import.meta.url),
  },
  "app.js": {
    type: "text/javascript; charset=utf-8",
    url: new URL("../public/app.js", import.meta.url),
  },
  "styles.css": {
    type: "text/css; charset=utf-8",
    url: new URL("../public/styles.css", import.meta.url),
  },
} as const;

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
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
    options.onControllerClosed();
  };
  const flushState = (): void => {
    publishTimer = undefined;
    const state = pendingState;
    const shouldPublish = hasPendingState;
    pendingState = undefined;
    hasPendingState = false;
    const socket = controller;
    if (!socket || socket.readyState !== WebSocket.OPEN || !shouldPublish) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      releaseController(socket);
      socket.terminate();
      return;
    }
    sendState(socket, state);
  };

  const server = createServer((request, response) => {
    void handleHttp(request, response, expectedHost, basePath);
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
      const input = parseInput(data.toString());
      if (!input) {
        releaseController(socket);
        socket.terminate();
        return;
      }
      options.onInput(input);
    });
    socket.on("close", () => releaseController(socket));
    socket.on("error", () => releaseController(socket));
    sendState(socket, options.getState());
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
    disconnect(): void {
      const socket = controller;
      if (!socket) return;
      releaseController(socket);
      socket.close(1008, "Session reset");
    },
    async close(): Promise<void> {
      const socket = controller;
      if (socket) {
        releaseController(socket);
        socket.close(1001, "Server shutting down");
      } else {
        cancelPendingPublish();
      }
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
      await closeHttpServer(server);
    },
  };
}

async function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  expectedHost: string,
  basePath: string,
): Promise<void> {
  setSecurityHeaders(response);
  if (request.method !== "GET" || request.headers.host !== expectedHost) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const isIndex = request.url === basePath;
  const relative = isIndex ? "index.html" : request.url?.slice(basePath.length);
  const expectedUrl = isIndex ? basePath : `${basePath}${relative ?? ""}`;
  if (!relative || !(relative in ASSETS) || request.url !== expectedUrl) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const asset = ASSETS[relative as keyof typeof ASSETS];
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

function parseInput(serialized: string): StudioInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "releaseAll" && exactKeys(value, ["type"])) return { type: "releaseAll" };
  if (
    (value.type === "keyDown" || value.type === "keyUp") &&
    exactKeys(value, ["code", "type"]) &&
    typeof value.code === "string" &&
    INPUT_CODES.has(value.code)
  ) {
    return { type: value.type, code: value.code };
  }
  return undefined;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendState(socket: WebSocket, state: unknown): void {
  socket.send(JSON.stringify({ type: "state", state }));
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
