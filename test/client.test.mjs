import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { AudioForgeClient } from "../scripts/client.mjs";

function startServer(onCommand) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => resolve(wss));
    wss.on("connection", (ws, req) => {
      ws.reqUrl = req.url;
      ws.send(JSON.stringify({ type: "state", musicPlaying: true, musicCategories: [] }));
      ws.send(JSON.stringify({ type: "catalog", activeLibraryUuid: "L", libraries: [] }));
      ws.on("message", (raw) => onCommand(ws, JSON.parse(raw.toString())));
    });
  });
}

const once = (target, name) => new Promise((r) => target.addEventListener(name, (e) => r(e.detail), { once: true }));

test("connects, receives state/catalog, correlates results, passes api key", async () => {
  let seenUrl = "";
  const wss = await startServer((ws, cmd) => {
    seenUrl = ws.reqUrl;
    if (cmd.command === "bad") ws.send(JSON.stringify({ type: "result", ok: false, error: "nope", requestId: cmd.requestId }));
    else ws.send(JSON.stringify({ type: "result", ok: true, message: "ok", requestId: cmd.requestId }));
  });
  const c = new AudioForgeClient();
  c.configure({ host: "127.0.0.1", port: wss.address().port, apiKey: "s3cret key" });
  const connected = once(c, "connection");
  c.start();
  assert.equal(await connected, true);
  await once(c, "catalog");
  assert.equal(c.state.musicPlaying, true);
  assert.equal((await c.send({ command: "play", section: "Music" })).ok, true);
  await assert.rejects(c.send({ command: "bad" }), /nope/);
  assert.match(seenUrl, /apiKey=s3cret%20key/);
  assert.equal(c.redact("x s3cret key y"), "x [redacted] y");
  c.stop();
  for (const s of wss.clients) s.terminate();
  wss.close();
});

test("send rejects when offline; pending commands reject on timeout", async () => {
  const c = new AudioForgeClient();
  await assert.rejects(c.send({ command: "play" }), /not connected/);
  const wss = await startServer(() => {});
  c.configure({ host: "127.0.0.1", port: wss.address().port });
  const connected = once(c, "connection");
  c.start();
  await connected;
  await assert.rejects(c.send({ command: "play" }, 50), /did not answer/);
  c.stop();
  for (const s of wss.clients) s.terminate();
  wss.close();
});

test("reconnects after the server drops the socket", async () => {
  const wss = await startServer(() => {});
  const c = new AudioForgeClient();
  c.configure({ host: "127.0.0.1", port: wss.address().port });
  let up = once(c, "connection");
  c.start();
  await up;
  const down = once(c, "connection");
  for (const ws of wss.clients) ws.terminate();
  assert.equal(await down, false);
  up = once(c, "connection");
  assert.equal(await up, true);
  c.stop();
  for (const s of wss.clients) s.terminate();
  wss.close();
});
