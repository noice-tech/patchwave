import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startStudioServer, type StudioInput } from "../src/server.js";

function openSocket(url: string): Promise<WebSocket> {
  const target = new URL("socket", url);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, { origin: new URL(url).origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function rejectedStatus(
  target: URL,
  origin: string,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(target, { origin, headers });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
}

test("serves capability-scoped assets with restrictive headers", async () => {
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => undefined,
    getState: () => ({ ready: true }),
  });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const html = await response.text();
    const script = html.match(/src="(\.\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(script);
    const scriptResponse = await fetch(new URL(script, server.url));
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(new URL(".vite/manifest.json", server.url))).status, 404);
    assert.equal((await fetch(new URL("missing", server.url))).status, 404);
  } finally {
    await server.close();
  }
});

test("coalesces rapid state publishing, sends the latest state, and cancels on release", async () => {
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => undefined,
    getState: () => ({ frame: 0 }),
  });
  const messages: Array<{ type: string; state: { frame: number } }> = [];
  const target = new URL("socket", server.url);
  const socket = new WebSocket(target, { origin: new URL(server.url).origin });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    for (let frame = 1; frame <= 120; frame += 1) server.publish({ frame });
    for (let attempt = 0; attempt < 30 && messages.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(messages, [
      { type: "state", state: { frame: 0 } },
      { type: "state", state: { frame: 120 } },
    ]);

    server.publish({ frame: 121 });
    server.disconnect();
    await closed(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(messages.length, 2);
  } finally {
    await server.close();
  }
});

test("server close cancels a pending coalesced state", async () => {
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => undefined,
    getState: () => ({ frame: 0 }),
  });
  const messages: unknown[] = [];
  const target = new URL("socket", server.url);
  const socket = new WebSocket(target, { origin: new URL(server.url).origin });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  for (let attempt = 0; attempt < 20 && messages.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(messages.length, 1);

  server.publish({ frame: 1 });
  await server.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, 1);
});

test("accepts one strict same-origin controller and releases on malformed input", async () => {
  const inputs: StudioInput[] = [];
  let releases = 0;
  const server = await startStudioServer({
    onInput: (input) => {
      inputs.push(input);
    },
    onControllerClosed: () => {
      releases += 1;
    },
    getState: () => ({ ready: true }),
  });
  try {
    const socket = await openSocket(server.url);
    const closePromise = closed(socket);
    socket.send(JSON.stringify({ type: "keyDown", code: "KeyA" }));
    for (let attempt = 0; attempt < 20 && inputs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.deepEqual(inputs, [{ type: "keyDown", code: "KeyA" }]);
    socket.send(JSON.stringify({ type: "keyUp", code: "KeyA", extra: true }));
    await closePromise;
    assert.equal(releases, 1);
  } finally {
    await server.close();
  }
});

test("malformed then valid pipelined messages cannot reacquire released control", async () => {
  const inputs: StudioInput[] = [];
  let releases = 0;
  const server = await startStudioServer({
    onInput: (input) => {
      inputs.push(input);
    },
    onControllerClosed: () => {
      releases += 1;
    },
    getState: () => ({}),
  });
  try {
    const socket = await openSocket(server.url);
    const closePromise = closed(socket);
    socket.send(JSON.stringify({ type: "keyDown", code: "KeyA", extra: true }));
    socket.send(JSON.stringify({ type: "keyDown", code: "KeyA" }));
    await closePromise;
    assert.deepEqual(inputs, []);
    assert.equal(releases, 1);
  } finally {
    await server.close();
  }
});

test("rejects unknown key codes, binary messages, and oversized payloads", async () => {
  const inputs: StudioInput[] = [];
  let releases = 0;
  const server = await startStudioServer({
    onInput: (input) => {
      inputs.push(input);
    },
    onControllerClosed: () => {
      releases += 1;
    },
    getState: () => ({}),
  });
  try {
    const unknown = await openSocket(server.url);
    const unknownClosed = closed(unknown);
    unknown.send(JSON.stringify({ type: "keyDown", code: "KeyQ" }));
    await unknownClosed;

    const binary = await openSocket(server.url);
    const binaryClosed = closed(binary);
    binary.send(Buffer.from(JSON.stringify({ type: "keyDown", code: "KeyA" })));
    await binaryClosed;

    const oversized = await openSocket(server.url);
    const oversizedClosed = closed(oversized);
    oversized.send("x".repeat(4_097));
    await oversizedClosed;

    assert.deepEqual(inputs, []);
    assert.equal(releases, 3);
  } finally {
    await server.close();
  }
});

test("rejects a second controller and the wrong route, host, or capability token", async () => {
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => undefined,
    getState: () => ({}),
  });
  try {
    const controller = await openSocket(server.url);
    const origin = new URL(server.url).origin;
    assert.equal(await rejectedStatus(new URL("socket", server.url), origin), 403);
    const controllerClosed = closed(controller);
    controller.close();
    await controllerClosed;

    assert.equal(await rejectedStatus(new URL("/session/wrong/socket", origin), origin), 403);
    const port = new URL(server.url).port;
    assert.equal(
      await rejectedStatus(new URL("socket", server.url), origin, { Host: `localhost:${port}` }),
      403,
    );
  } finally {
    await server.close();
  }
});

test("rejects a cross-origin WebSocket upgrade", async () => {
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => undefined,
    getState: () => ({}),
  });
  try {
    const target = new URL("socket", server.url);
    assert.equal(await rejectedStatus(target, "https://example.com"), 403);
  } finally {
    await server.close();
  }
});

test("sends reliable edit acknowledgements independently of coalesced runtime state", async () => {
  const revision = "a".repeat(64);
  const server = await startStudioServer({
    onInput: (input) =>
      input.type === "undo"
        ? {
            type: "editResult" as const,
            protocol: 1 as const,
            requestId: input.requestId,
            status: "rejected" as const,
            revision,
            message: "Nothing to undo",
          }
        : undefined,
    onControllerClosed: () => undefined,
    getState: () => ({ frame: 0 }),
  });
  const socket = await openSocket(server.url);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  try {
    socket.send(
      JSON.stringify({ type: "undo", protocol: 1, requestId: "undo-1", baseRevision: revision }),
    );
    for (
      let attempt = 0;
      attempt < 30 && !messages.some((message) => message.type === "editResult");
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(
      messages.find((message) => message.type === "editResult"),
      {
        type: "editResult",
        protocol: 1,
        requestId: "undo-1",
        status: "rejected",
        revision,
        message: "Nothing to undo",
      },
    );
  } finally {
    socket.close();
    await server.close();
  }
});

test("malformed edit followed by a valid commit cannot reach write authority", async () => {
  const inputs: StudioInput[] = [];
  const revision = "a".repeat(64);
  const server = await startStudioServer({
    onInput: (input) => {
      inputs.push(input);
    },
    onControllerClosed: () => undefined,
    getState: () => ({}),
  });
  try {
    const socket = await openSocket(server.url);
    const closePromise = closed(socket);
    socket.send(
      JSON.stringify({
        type: "commit",
        protocol: 1,
        requestId: "bad",
        gestureId: null,
        baseRevision: revision,
        operation: { type: "setField", path: ["source", "gainDb"], value: -12 },
        source: "export default evil",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "commit",
        protocol: 1,
        requestId: "good",
        gestureId: null,
        baseRevision: revision,
        operation: { type: "setField", path: ["source", "gainDb"], value: -12 },
      }),
    );
    await closePromise;
    assert.deepEqual(inputs, []);
  } finally {
    await server.close();
  }
});

test("synchronous input and cleanup throws fail closed before pipelined input", async () => {
  let releases = 0;
  const inputs: StudioInput[] = [];
  const server = await startStudioServer({
    onInput: (input) => {
      inputs.push(input);
      if (inputs.length === 1) throw new Error("sync boom");
    },
    onControllerClosed: () => {
      releases += 1;
      throw new Error("cleanup boom");
    },
    getState: () => ({ ready: true }),
  });
  try {
    const first = await openSocket(server.url);
    const firstClosed = closed(first);
    first.send(JSON.stringify({ type: "releaseAll" }));
    first.send(JSON.stringify({ type: "keyDown", code: "KeyA" }));
    await firstClosed;
    assert.equal(releases, 1);
    assert.deepEqual(inputs, [{ type: "releaseAll" }]);
    const replacement = await openSocket(server.url);
    const replacementClosed = closed(replacement);
    server.disconnect();
    await replacementClosed;
    assert.equal(releases, 2);
  } finally {
    await server.close();
  }
});

test("oversized or unserializable outbound state releases the controller", async () => {
  let state: unknown = { ready: true };
  let releases = 0;
  const server = await startStudioServer({
    onInput: () => ({ type: "state", state }) as const,
    onControllerClosed: () => {
      releases += 1;
    },
    getState: () => ({ ready: true }),
  });
  try {
    const oversized = await openSocket(server.url);
    const oversizedClosed = closed(oversized);
    state = { text: "x".repeat(70_000) };
    oversized.send(JSON.stringify({ type: "releaseAll" }));
    await oversizedClosed;
    assert.equal(releases, 1);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const second = await openSocket(server.url);
    const secondClosed = closed(second);
    state = cyclic;
    second.send(JSON.stringify({ type: "releaseAll" }));
    await secondClosed;
    assert.equal(releases, 2);
  } finally {
    await server.close();
  }
});

test("unserializable initial state releases authority and allows a replacement", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  let state: unknown = cyclic;
  let releases = 0;
  const server = await startStudioServer({
    onInput: () => undefined,
    onControllerClosed: () => {
      releases += 1;
    },
    getState: () => state,
  });
  try {
    const target = new URL("socket", server.url);
    const first = new WebSocket(target, { origin: new URL(server.url).origin });
    await closed(first);
    assert.equal(releases, 1);
    state = { ready: true };
    const replacement = await openSocket(server.url);
    server.disconnect();
    await closed(replacement);
    assert.equal(releases, 2);
  } finally {
    await server.close();
  }
});
