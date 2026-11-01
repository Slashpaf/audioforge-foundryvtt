import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient } from "../scripts/rooms/guest-client.mjs";
import { RemoteControlClient } from "../scripts/rooms/remote-control.mjs";

const snapshot = {
  state: { musicPlaying: true, musicVolume: 0.4 },
  catalog: { activeLibraryUuid: "L", libraries: [{ uuid: "L", name: "Lib" }] },
  savedStates: [{ id: "s1", name: "Tavern" }],
};
const room = (permission, hostConnected = true) => ({ hostConnected, guests: [{ clientId: "c1", username: "Aria", permission }], permissions: { defaultGuestPermission: "listen", guestPermissions: {} } });
const once = (t, name, pred = () => true) =>
  new Promise((resolve) => {
    const on = (ev) => {
      if (!pred(ev)) return;
      t.removeEventListener(name, on);
      resolve(ev.detail);
    };
    t.addEventListener(name, on);
  });

/** Rooms server stand-in: `onCommand(ws, msg)` answers control.command; the test pushes room state and snapshots itself. */
async function setup(onCommand = () => {}) {
  let sock;
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0, path: "/ws" }, () => resolve(s));
    s.on("connection", (ws) => {
      sock = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "guest.hello") ws.send(JSON.stringify({ type: "server.hello", clientId: "c1", role: "guest", username: "Aria", room: room("listen") }));
        else if (msg.type === "control.command") onCommand(ws, msg);
      });
    });
  });
  const guest = new RoomGuestClient();
  const remote = new RemoteControlClient(guest);
  const joined = once(guest, "status", (ev) => ev.detail.status === "joined");
  guest.join({ baseUrl: `http://127.0.0.1:${wss.address().port}`, roomId: "R", username: "Aria", sessionId: "s", password: "" });
  await joined;
  const grant = async () => {
    const ready = once(remote, "state", (ev) => ev.detail);
    sock.send(JSON.stringify({ type: "room.state", room: room("control") }));
    sock.send(JSON.stringify({ type: "control.snapshot", snapshot }));
    await ready;
  };
  const stop = () => {
    guest.leave();
    for (const s of wss.clients) s.terminate();
    wss.close();
  };
  return { wss: () => wss, guest, remote, sock: () => sock, grant, stop };
}

test("mirrors the host snapshot as state, catalog and saved states", async () => {
  const { remote, grant, stop, wss } = await setup();
  assert.equal(remote.connected, false);
  assert.equal(remote.available, false);
  await grant();
  assert.equal(remote.connected, true);
  assert.equal(remote.state.musicVolume, 0.4);
  assert.equal(remote.catalog.activeLibraryUuid, "L");
  assert.deepEqual(remote.savedStates, [{ id: "s1", name: "Tavern" }]);
  assert.equal(remote.iconUrl("a b/1", 96), `http://127.0.0.1:${wss().address().port}/api/rooms/R/control-icons/a%20b%2F1`);
  stop();
});

test("send relays {command, ...fields} as control.command args and resolves on the result", async () => {
  let seen;
  const { remote, grant, stop } = await setup((ws, msg) => {
    seen = msg;
    ws.send(JSON.stringify({ type: "control.result", requestId: msg.requestId, ok: true }));
  });
  await grant();
  const result = await remote.send({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: "u", enabled: false });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.payload, { command: "setCategoryEnabled", args: { section: "Ambiance", categoryUuid: "u", enabled: false } });
  assert.match(seen.requestId, /\S/);
  stop();
});

test("a burst of volume changes is paced: few commands reach the host, the last value wins, none fails", async () => {
  const seen = [];
  const { remote, grant, stop } = await setup((ws, msg) => {
    seen.push(msg.payload);
    ws.send(JSON.stringify({ type: "control.result", requestId: msg.requestId, ok: true }));
  });
  await grant();
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => remote.send({ command: "setVolume", section: "Music", value: i / 100 })));
  assert.ok(results.every((r) => r.ok));
  await new Promise((r) => setTimeout(r, 400));
  const music = seen.filter((p) => p.command === "setVolume");
  assert.ok(music.length >= 2 && music.length <= 3, `sent ${music.length}`);
  assert.equal(music.at(-1).args.value, 0.99);
  // Sections are paced independently, and other commands are never held back.
  seen.length = 0;
  await Promise.all([remote.send({ command: "setVolume", section: "Ambiance", value: 0.5 }), remote.send({ command: "setVolume", section: "Echoes", value: 0.2 }), remote.send({ command: "stop", section: "All" })]);
  assert.deepEqual(seen.map((p) => p.command).sort(), ["setVolume", "setVolume", "stop"]);
  stop();
});

test("send rejects on an error result, on timeout, and when not allowed", async () => {
  const { remote, grant, stop } = await setup((ws, msg) => {
    if (msg.payload.command === "stop") ws.send(JSON.stringify({ type: "control.result", requestId: msg.requestId, ok: false, error: "forbidden" }));
  });
  await assert.rejects(remote.send({ command: "stop", section: "All" }), /not connected/);
  await grant();
  await assert.rejects(remote.send({ command: "stop", section: "All" }), /forbidden/);
  await assert.rejects(remote.send({ command: "play", section: "Music" }, 30), /did not answer/);
  stop();
});

test("revoking clears the data and fails commands still waiting", async () => {
  const { remote, sock, grant, stop } = await setup(() => {});
  await grant();
  const pending = remote.send({ command: "play", section: "Music" });
  const gone = once(remote, "connection");
  sock().send(JSON.stringify({ type: "control.snapshot", snapshot: null }));
  assert.equal(await gone, false);
  await assert.rejects(pending, /closed/);
  assert.equal(remote.state, null);
  assert.deepEqual(remote.savedStates, []);
  stop();
});

test("a server error for a request rejects it at once", async () => {
  const { remote, grant, stop } = await setup((ws, msg) => ws.send(JSON.stringify({ type: "error", code: "rate_limited", requestId: msg.requestId })));
  await grant();
  const t = Date.now();
  await assert.rejects(remote.send({ command: "play", section: "Music" }), /rate_limited/);
  assert.ok(Date.now() - t < 1000);
  stop();
});

test("the panel is disconnected while the host is offline", async () => {
  const { remote, sock, grant, stop } = await setup();
  await grant();
  assert.equal(remote.connected, true);
  const off = once(remote, "connection");
  sock().send(JSON.stringify({ type: "room.state", room: room("control", false) }));
  assert.equal(await off, false);
  stop();
});
