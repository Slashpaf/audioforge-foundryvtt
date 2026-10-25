import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient, roomWebSocketUrl } from "../scripts/rooms/guest-client.mjs";

/** A stand-in for the rooms server: answers guest.hello via `onHello(ws, hello)`. */
function startServer(onHello) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, path: "/ws" }, () => resolve(wss));
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "guest.hello") onHello(ws, msg);
      });
    });
  });
}

const base = (wss) => `http://127.0.0.1:${wss.address().port}`;
const hello = (ws, extra = {}) =>
  ws.send(JSON.stringify({ type: "server.hello", clientId: "c1", role: "guest", username: "Aria", room: { guests: [], maxGuests: 5 }, ...extra }));
const reject = (ws, code, closeCode) => {
  ws.send(JSON.stringify({ type: "error", code, message: code }));
  setTimeout(() => ws.close(closeCode, code), 10);
};
const statusIs = (c, status) =>
  new Promise((resolve) => {
    const on = (ev) => {
      if (ev.detail.status === status) {
        c.removeEventListener("status", on);
        resolve(ev.detail);
      }
    };
    c.addEventListener("status", on);
  });
const done = (c, wss) => {
  c.leave();
  for (const s of wss.clients) s.terminate();
  wss.close();
};

test("builds the websocket url from the room base url", () => {
  assert.equal(roomWebSocketUrl("https://eu1.rooms.audioforge.app"), "wss://eu1.rooms.audioforge.app/ws");
  assert.equal(roomWebSocketUrl("http://localhost:8080/r/abc?x=1"), "ws://localhost:8080/ws");
});

test("joins with the foundry identity and plays binary and base64 audio", async () => {
  let seen;
  const wss = await startServer((ws, msg) => {
    seen = msg;
    hello(ws);
    ws.send(JSON.stringify({ type: "audio.format", payload: { codec: "pcm16", sampleRate: 32000, channels: 2 } }));
    ws.send(Buffer.from([1, 0, 2, 0]));
    ws.send(JSON.stringify({ type: "audio.chunk", payload: { sequence: 0, pcm16Base64: Buffer.from([3, 0]).toString("base64") } }));
  });
  const formats = [];
  const chunks = [];
  const c = new RoomGuestClient({ onFormat: (f) => formats.push(f), onPcm: (b) => chunks.push([...b]) });
  const joined = statusIs(c, "joined");
  c.join({ baseUrl: base(wss), roomId: "ROOM", username: "Aria", sessionId: "fvtt-w-u1", password: "pw" });
  assert.equal((await joined).clientId, "c1");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, { type: "guest.hello", roomId: "ROOM", username: "Aria", sessionId: "fvtt-w-u1", password: "pw" });
  assert.deepEqual(formats, [{ sampleRate: 32000, channels: 2 }]);
  assert.deepEqual(chunks, [[1, 0, 2, 0], [3, 0]]);
  done(c, wss);
});

test("a full room ends in 'waiting' and is not retried", async () => {
  let hellos = 0;
  const wss = await startServer((ws) => {
    hellos++;
    reject(ws, "room_full", 4409);
  });
  const c = new RoomGuestClient();
  const waiting = statusIs(c, "waiting");
  c.join({ baseUrl: base(wss), roomId: "ROOM", username: "Bram" });
  assert.equal((await waiting).reason, "room_full");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(hellos, 1);
  assert.equal(c.status, "waiting");
  done(c, wss);
});

test("being removed by the host is final", async () => {
  const wss = await startServer((ws) => {
    hello(ws);
    setTimeout(() => reject(ws, "kicked", 4403), 20);
  });
  const c = new RoomGuestClient();
  const removed = statusIs(c, "removed");
  c.join({ baseUrl: base(wss), roomId: "ROOM", username: "Aria" });
  assert.equal((await removed).reason, "kicked");
  done(c, wss);
});

test("a dropped connection reconnects and a wrong password is reported", async () => {
  let n = 0;
  const wss = await startServer((ws) => {
    n++;
    if (n === 1) ws.terminate();
    else reject(ws, "invalid_room_password", 4401);
  });
  const c = new RoomGuestClient();
  const failed = statusIs(c, "error");
  c.join({ baseUrl: base(wss), roomId: "ROOM", username: "Aria" });
  assert.equal((await failed).reason, "invalid_room_password");
  assert.equal(n, 2);
  done(c, wss);
});

test("leave() stops reconnecting", async () => {
  let n = 0;
  const wss = await startServer((ws) => {
    n++;
    ws.terminate();
  });
  const c = new RoomGuestClient();
  c.join({ baseUrl: base(wss), roomId: "ROOM", username: "Aria" });
  await new Promise((r) => setTimeout(r, 100));
  c.leave();
  const seen = n;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(n, seen);
  assert.equal(c.status, "idle");
  done(c, wss);
});
