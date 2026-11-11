import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient, isMixedContent } from "../scripts/rooms/guest-client.mjs";

const statusIs = (c, status, reason) =>
  new Promise((resolve) => {
    const on = (ev) => {
      if (ev.detail.status !== status || (reason !== undefined && ev.detail.reason !== reason)) return;
      c.removeEventListener("status", on);
      resolve(ev.detail);
    };
    c.addEventListener("status", on);
  });
const cfg = (baseUrl) => ({ baseUrl, roomId: "R", username: "Aria", sessionId: "s", password: "" });
const withPage = async (protocol, fn) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: { protocol }, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    if (before) Object.defineProperty(globalThis, "location", before);
    else delete globalThis.location;
  }
};
const server = (port = 0) =>
  new Promise((resolve) => {
    const connections = [];
    const wss = new WebSocketServer({ port, path: "/ws", host: "127.0.0.1" }, () => resolve({ wss, connections }));
    wss.on("connection", (ws) => {
      connections.push(ws);
      ws.on("message", () => ws.send(JSON.stringify({ type: "server.hello", clientId: "c1", role: "guest", username: "Aria", room: { guests: [] } })));
    });
  });

test("mixed content: an HTTPS page and a plain http, non-loopback server is refused without connecting", async () => {
  await withPage("https:", async () => {
    const { wss, connections } = await server();
    const c = new RoomGuestClient();
    const refused = statusIs(c, "error", "mixed_content");
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(String(m));
    // The server really listens on loopback, but the guest is told a LAN address: it must not even try.
    c.join(cfg("http://192.168.0.9:8080"));
    console.warn = warn;
    const detail = await refused;
    assert.equal(detail.status, "error");
    assert.equal(c.target, "192.168.0.9:8080");
    assert.match(warned.join(), /ws:\/\/192\.168\.0\.9:8080\/ws/);
    await new Promise((r) => setTimeout(r, 1300)); // longer than the first retry: there is none
    assert.equal(c.status, "error");
    assert.equal(connections.length, 0);
    c.leave();
    wss.close();
  });
});

test("mixed content: loopback and https servers are exempt, plain pages are unaffected", async () => {
  await withPage("https:", async () => {
    assert.equal(isMixedContent("http://localhost:8080"), false);
    assert.equal(isMixedContent("http://127.0.0.1:8080"), false);
    assert.equal(isMixedContent("http://[::1]:8080"), false);
    assert.equal(isMixedContent("https://rooms.audioforge.app"), false);
    assert.equal(isMixedContent("http://192.168.0.9:8080"), true);
    const { wss, connections } = await server();
    const c = new RoomGuestClient();
    const joined = statusIs(c, "joined");
    c.join(cfg(`http://127.0.0.1:${wss.address().port}`));
    await joined;
    assert.equal(connections.length, 1);
    c.leave();
    for (const s of wss.clients) s.terminate();
    wss.close();
  });
  await withPage("http:", async () => assert.equal(isMixedContent("http://192.168.0.9:8080"), false));
  assert.equal(isMixedContent("http://192.168.0.9:8080"), false); // no location at all (Node)
});

test("unreachable server: shown after repeated failures, retries continue and it recovers when the server appears", async () => {
  const probe = await server();
  const port = probe.wss.address().port;
  await new Promise((r) => probe.wss.close(r)); // nothing listens on this port now
  const c = new RoomGuestClient();
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  c.join(cfg(`http://127.0.0.1:${port}`));
  const seen = await statusIs(c, "connecting", "unreachable");
  console.warn = warn;
  assert.equal(seen.reason, "unreachable");
  assert.equal(c.target, `127.0.0.1:${port}`);
  assert.equal(warned.length, 1);
  assert.match(warned[0], new RegExp(`ws://127\\.0\\.0\\.1:${port}/ws`));
  // The server appears: the next retry joins and the unreachable state is gone.
  const live = await server(port);
  const joined = statusIs(c, "joined");
  await joined;
  assert.equal(c.reason, null);
  assert.equal(live.connections.length >= 1, true);
  c.leave();
  for (const s of live.wss.clients) s.terminate();
  live.wss.close();
});
