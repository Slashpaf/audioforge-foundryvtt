import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

// Minimal Foundry globals: the session logic only needs settings, a socket, notifications and users.
const emitted = [];
const notes = [];
const settings = new Map([["roomsServerUrl", "https://rooms.test"], ["roomPassword", ""], ["roomOptOut", ""], ["roomVolume", 1]]);
globalThis.game = {
  settings: { get: (_m, k) => settings.get(k), set: async (_m, k, v) => settings.set(k, v) },
  socket: { emit: (_c, d) => emitted.push(d), on() {} },
  users: [],
  user: { isGM: true, id: "gm", name: "GM" },
  world: { id: "w" },
};
globalThis.ui = { notifications: { info: (m) => notes.push(m), warn: () => {} } };

const { roomSession } = await import("../scripts/rooms/session.mjs");
const { client } = await import("../scripts/settings.mjs");

const status = (roomId = "ROOM1") => ({ running: true, roomId, roomUrl: `https://rooms.test/r/${roomId}`, roomPassword: "", roomAccessTier: "free", roomMaxGuests: 5, guests: [] });

/** Local API stand-in. `app.on(command, handler)`: handler(cmd) returns a result object or throws an Error for an error result. */
async function startApp({ features }) {
  const calls = [];
  const handlers = {};
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => resolve(s));
    s.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello", apiVersion: 3, ...(features ? { features } : {}) }));
      ws.on("message", (raw) => {
        const cmd = JSON.parse(raw.toString());
        calls.push(cmd);
        try {
          const out = handlers[cmd.command]?.(cmd) ?? {};
          ws.send(JSON.stringify({ type: "result", ok: true, requestId: cmd.requestId, ...out }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", ok: false, error: err.message, requestId: cmd.requestId }));
        }
      });
    });
  });
  client.configure({ host: "127.0.0.1", port: wss.address().port });
  const hello = new Promise((r) => client.addEventListener("aiDirector", () => r(), { once: true }));
  client.start();
  await hello;
  // Without features in the hello the client asks GET /api/info (the mock has none): wait for that answer.
  if (!features) for (let i = 0; i < 100 && Object.keys(client.features).length; i++) await new Promise((r) => setTimeout(r, 20));
  const names = () => calls.map((c) => c.command);
  const stop = async () => {
    await roomSession.close().catch(() => {});
    client.stop();
    for (const s of wss.clients) s.terminate();
    wss.close();
  };
  return { calls, names, on: (c, h) => (handlers[c] = h), stop };
}
const reset = () => {
  emitted.length = 0;
  notes.length = 0;
};

test("resume: a recoverable room is resumed, announced to players and notified", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "ROOM1", roomUrl: "https://rooms.test/r/ROOM1", hostGraceRemainingSeconds: 240 }));
  app.on("startAudioCapture", () => ({ status: status() }));
  await roomSession.open("");
  assert.deepEqual(app.names(), ["getRecoverableRoom", "startAudioCapture"]);
  assert.equal(app.calls[1].resume, true);
  assert.equal(roomSession.room.roomId, "ROOM1");
  assert.ok(emitted.some((d) => d.action === "room" && d.room?.roomId === "ROOM1"));
  assert.deepEqual(notes, ["AUDIOFORGE.Room.Resumed"]);
  await app.stop();
});

test("resume refused: falls back to creating a new room", async () => {
  for (const reason of ["no recoverable room", "room not recoverable"]) {
    reset();
    const app = await startApp({ features: { roomRecovery: true } });
    app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "OLD" }));
    app.on("startAudioCapture", (cmd) => {
      if (cmd.resume) throw new Error(reason);
      return { status: status("NEW1") };
    });
    await roomSession.open("");
    assert.deepEqual(app.calls.filter((c) => c.command === "startAudioCapture").map((c) => !!c.resume), [true, false]);
    assert.equal(roomSession.room.roomId, "NEW1");
    assert.deepEqual(notes, []);
    await app.stop();
  }
});

test("room already running: the app's room is adopted, nothing is created", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "ROOM1" }));
  app.on("startAudioCapture", () => {
    throw new Error("room already running");
  });
  app.on("getAudioCaptureStatus", () => ({ status: status("RUN1") }));
  await roomSession.open("");
  assert.equal(app.calls.filter((c) => c.command === "startAudioCapture").length, 1);
  assert.equal(roomSession.room.roomId, "RUN1");
  await app.stop();
});

test("other resume errors surface and nothing is created", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "ROOM1" }));
  app.on("startAudioCapture", () => {
    throw new Error("a room is already starting");
  });
  await assert.rejects(roomSession.open(""), /already starting/);
  assert.equal(app.calls.filter((c) => c.command === "startAudioCapture").length, 1);
  await app.stop();
});

test("nothing recoverable, or a fresh start asked for: a new room without resume", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: false }));
  app.on("startAudioCapture", () => ({ status: status("NEW2") }));
  await roomSession.open("");
  assert.equal(app.calls.find((c) => c.command === "startAudioCapture").resume, undefined);
  await roomSession.close();
  app.calls.length = 0;
  app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "OLD" }));
  await roomSession.open("", { fresh: true });
  assert.deepEqual(app.names(), ["startAudioCapture"]);
  assert.equal(app.calls[0].resume, undefined);
  await app.stop();
});

test("automatic close is recoverable, the explicit close is for good", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: false }));
  app.on("startAudioCapture", () => ({ status: status() }));
  await roomSession.open("");
  await roomSession.close({ recoverable: true });
  assert.deepEqual(app.calls.filter((c) => c.command === "stopAudioCapture").map((c) => c.recoverable), [true]);
  await roomSession.open("");
  app.calls.length = 0;
  await roomSession.close({ byHand: true });
  assert.equal(app.calls.find((c) => c.command === "stopAudioCapture").recoverable, undefined);
  await app.stop();
});

test("old app without features.roomRecovery: today's calls only", async () => {
  reset();
  const app = await startApp({});
  app.on("startAudioCapture", () => ({ status: status("OLD1") }));
  await roomSession.open("");
  assert.deepEqual(app.names(), ["startAudioCapture"]);
  assert.equal(app.calls[0].resume, undefined);
  assert.equal(client.roomRecoveryAvailable, false);
  await roomSession.close({ recoverable: true });
  assert.equal(app.calls.find((c) => c.command === "stopAudioCapture").recoverable, undefined);
  await roomSession.refreshRecoverable();
  assert.equal(roomSession.recoverable, null);
  await app.stop();
});

test("the recoverable room is exposed for the room manager, and never while a room is open", async () => {
  reset();
  const app = await startApp({ features: { roomRecovery: true } });
  app.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "OLD9", roomUrl: "https://rooms.test/r/OLD9", accessTier: "free", hostGraceRemainingSeconds: 150 }));
  await roomSession.refreshRecoverable();
  assert.equal(roomSession.recoverable.roomId, "OLD9");
  assert.equal(roomSession.recoverable.hostGraceRemainingSeconds, 150);
  app.on("startAudioCapture", () => ({ status: status("OLD9") }));
  await roomSession.open("");
  assert.equal(roomSession.recoverable, null);
  await app.stop();
  // "unknown" (the server could not be asked) is not offered.
  const app2 = await startApp({ features: { roomRecovery: true } });
  app2.on("getRecoverableRoom", () => ({ recoverable: true, roomId: "X", unknown: true }));
  assert.equal(await client.getRecoverableRoom(), null);
  await app2.stop();
});
