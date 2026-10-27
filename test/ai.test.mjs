import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { AudioForgeClient } from "../scripts/client.mjs";
import { PcmBatcher, PcmConverter, toLittleEndianBytes } from "../scripts/ai/pcm.mjs";

const once = (target, name) => new Promise((r) => target.addEventListener(name, (e) => r(e.detail), { once: true }));

function serve(onConnect) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => resolve(wss));
    wss.on("connection", (ws) => {
      ws.binary = [];
      ws.commands = [];
      ws.on("message", (raw, isBinary) => {
        if (isBinary) ws.binary.push(raw);
        else ws.commands.push(JSON.parse(raw.toString()));
      });
      onConnect(ws);
    });
  });
}

const close = (c, wss) => {
  c.stop();
  for (const s of wss.clients) s.terminate();
  wss.close();
};

const status = (over = {}) => ({ type: "ai_director", available: true, enabled: true, entitled: true, modelsReady: true, state: "idle", inputSource: "device", ...over });

async function connect(onConnect) {
  const wss = await serve(onConnect);
  const c = new AudioForgeClient();
  c.configure({ host: "127.0.0.1", port: wss.address().port });
  c.start();
  await once(c, "connection");
  return { c, wss };
}

test("an old Audio Forge (no hello) never exposes the AI Director, even if it sent a status", async () => {
  const { c, wss } = await connect((ws) => ws.send(JSON.stringify(status())));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.apiVersion, 0);
  assert.equal(c.aiDirectorAvailable, false);
  await assert.rejects(c.sendAiDirector({ command: "aiDirectorStart" }), /not available/);
  assert.equal(c.sendAudio(new ArrayBuffer(4)), false);
  assert.equal(wss.clients.values().next().value.commands.length, 0);
  close(c, wss);
});

test("api v2 with the feature off in the app is not available", async () => {
  const { c, wss } = await connect((ws) => {
    ws.send(JSON.stringify({ type: "hello", apiVersion: 2, features: { aiDirector: { available: true, enabled: false } } }));
    ws.send(JSON.stringify(status({ enabled: false })));
  });
  await once(c, "aiDirector");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.apiVersion, 2);
  assert.equal(c.aiDirectorAvailable, false);
  close(c, wss);
});

test("api v2 available: commands go out, audio goes out as binary, the log accumulates, reset on disconnect", async () => {
  let serverWs;
  const { c, wss } = await connect((ws) => {
    serverWs = ws;
    ws.send(JSON.stringify({ type: "hello", apiVersion: 2, features: {} }));
    ws.send(JSON.stringify(status()));
    ws.send(JSON.stringify({ type: "ai_director_log", reset: true, entries: [{ id: 1, at: "2026-01-01T00:00:00Z", kind: "info", text: "a" }] }));
    ws.on("message", (raw, isBinary) => {
      if (!isBinary) ws.send(JSON.stringify({ type: "result", ok: true, requestId: JSON.parse(raw.toString()).requestId }));
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.aiDirectorAvailable, true);
  assert.equal((await c.sendAiDirector({ command: "aiDirectorStart", inputSource: "remote" })).ok, true);
  assert.equal(c.sendAudio(new Uint8Array([1, 0, 2, 0]).buffer), true);
  serverWs.send(JSON.stringify({ type: "ai_director_log", reset: false, entries: [{ id: 2, at: "2026-01-01T00:00:01Z", kind: "action", text: "b" }] }));
  await once(c, "aiDirectorLog");
  assert.deepEqual(c.aiDirectorLog.map((e) => e.id), [1, 2]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(serverWs.commands[0].command, "aiDirectorStart");
  assert.equal(serverWs.binary.length, 1);
  const gone = once(c, "connection");
  serverWs.terminate();
  await gone;
  assert.equal(c.aiDirectorAvailable, false);
  assert.deepEqual(c.aiDirectorLog, []);
  close(c, wss);
});

test("a log entry delivered twice is kept once", async () => {
  let serverWs;
  const { c, wss } = await connect((ws) => {
    serverWs = ws;
    ws.send(JSON.stringify({ type: "hello", apiVersion: 2, features: {} }));
    ws.send(JSON.stringify(status()));
    ws.send(JSON.stringify({ type: "ai_director_log", reset: true, entries: [{ id: 5, at: "2026-01-01T00:00:00Z", kind: "info", text: "a" }] }));
  });
  await once(c, "aiDirectorLog");
  const again = once(c, "aiDirectorLog");
  serverWs.send(JSON.stringify({ type: "ai_director_log", reset: false, entries: [{ id: 5, at: "x", kind: "info", text: "a" }, { id: 6, at: "x", kind: "info", text: "b" }] }));
  await again;
  assert.deepEqual(c.aiDirectorLog.map((e) => e.id), [5, 6]);
  close(c, wss);
});

test("PcmConverter downsamples 48 kHz to 16 kHz across block boundaries", () => {
  const conv = new PcmConverter(48000);
  const ones = new Float32Array(100).fill(0.5);
  const total = conv.convert(ones).length + conv.convert(ones).length + conv.convert(ones).length;
  assert.equal(total, 100); // 300 input samples / 3
  const out = new PcmConverter(48000).convert(new Float32Array([1, 1, 1, -1, -1, -1]));
  assert.deepEqual([...out], [0x7fff, -0x8000]);
});

test("PcmBatcher waits for ~100 ms and the bytes are little-endian", () => {
  const b = new PcmBatcher(4);
  assert.equal(b.push(new Int16Array([1, 2])), null);
  const frame = b.push(new Int16Array([3, 0x0102]));
  assert.deepEqual([...new Uint8Array(frame)], [1, 0, 2, 0, 3, 0, 2, 1]);
  assert.deepEqual([...new Uint8Array(toLittleEndianBytes(Int16Array.of(-1)))], [255, 255]);
});
