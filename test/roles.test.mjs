import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient } from "../scripts/rooms/guest-client.mjs";
import { RemoteControlClient } from "../scripts/rooms/remote-control.mjs";
import { AudioForgeClient } from "../scripts/client.mjs";
import { accessOf, buildPlayerRows, findStrangers, roleChoices } from "../scripts/rooms/roster.mjs";

const room = (permission) => ({
  hostConnected: true,
  guests: [{ clientId: "c1", username: "Aria", permission }],
  permissions: { defaultGuestPermission: "listen", guestPermissions: {} },
});
const once = (t, name, pred = () => true) =>
  new Promise((resolve) => {
    const on = (ev) => {
      if (!pred(ev)) return;
      t.removeEventListener(name, on);
      resolve(ev.detail);
    };
    t.addEventListener(name, on);
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const stop = () => {
    guest.leave();
    for (const s of wss.clients) s.terminate();
    wss.close();
  };
  return { guest, remote, sock: () => sock, stop };
}

const access = { mode: "roles", fullLayers: ["Music"], stopAll: false, savedStates: false, libraries: false };
const snapshot = { state: { musicVolume: 0.4, categoryVolume: { a: 0.5 } }, catalog: { libraries: [] }, savedStates: [], access };

test("roles mode keeps the snapshot like control, listen clears it, unknown values fail closed", async () => {
  const { guest, sock, stop } = await setup();
  assert.equal(guest.mayControl, false);
  sock().send(JSON.stringify({ type: "room.state", room: room("roles") }));
  sock().send(JSON.stringify({ type: "control.snapshot", snapshot }));
  await once(guest, "control", () => guest.snapshot);
  assert.equal(guest.permission, "roles");
  assert.equal(guest.mayControl, true);
  // A room update that keeps roles mode does not drop the snapshot.
  sock().send(JSON.stringify({ type: "room.state", room: room("roles") }));
  await wait(50);
  assert.deepEqual(guest.snapshot, snapshot);
  sock().send(JSON.stringify({ type: "room.state", room: room("listen") }));
  await once(guest, "control", () => !guest.snapshot);
  assert.equal(guest.permission, "listen");
  sock().send(JSON.stringify({ type: "room.state", room: room("admin") }));
  await wait(50);
  assert.equal(guest.permission, "listen");
  stop();
});

test("a guest in roles mode is available, exposes access, and paces category volumes separately", async () => {
  const seen = [];
  const { remote, guest, sock, stop } = await setup((ws, msg) => {
    seen.push(msg.payload);
    ws.send(JSON.stringify({ type: "control.result", requestId: msg.requestId, ok: true }));
  });
  assert.equal(remote.available, false);
  const ready = once(remote, "state", (ev) => ev.detail);
  sock().send(JSON.stringify({ type: "room.state", room: room("roles") }));
  sock().send(JSON.stringify({ type: "control.snapshot", snapshot }));
  await ready;
  assert.equal(guest.permission, "roles");
  assert.equal(remote.available, true);
  assert.equal(remote.connected, true);
  assert.deepEqual(remote.access, access);
  await Promise.all([
    remote.send({ command: "setVolume", section: "Music", categoryUuid: "a", value: 0.3 }),
    remote.send({ command: "setVolume", section: "Music", categoryUuid: "b", value: 0.6 }),
  ]);
  assert.deepEqual(seen.map((p) => p.args.categoryUuid).sort(), ["a", "b"]);
  const gone = once(remote, "connection");
  sock().send(JSON.stringify({ type: "control.snapshot", snapshot: null }));
  await gone;
  assert.equal(remote.access, null);
  stop();
});

test("rows and strangers carry the access mode and role names", () => {
  const users = [
    { id: "u1", name: "Aria", active: true },
    { id: "u2", name: "Bram", active: true },
    { id: "u3", name: "Cleo", active: false },
  ];
  const guests = [
    { clientId: "c1", username: "Aria", permission: "roles", roleIds: ["r1"], roleNames: ["Bard"] },
    { clientId: "c2", username: "Bram", permission: "listen", roleIds: ["r1"], roleNames: ["Bard"] },
    { clientId: "c9", username: "Link", permission: "roles" },
  ];
  const reports = new Map([["u1", { state: "joined", clientId: "c1" }], ["u2", { state: "joined", clientId: "c2" }]]);
  const rows = buildPlayerRows(users, reports, guests);
  assert.deepEqual(rows.map((r) => [r.mode, r.roleLabel, r.canControl]), [["roles", "Bard", false], ["listen", "", false], ["listen", "", false]]);
  assert.deepEqual(findStrangers(reports, guests).map((g) => [g.mode, g.isRoles, g.roleIds]), [["roles", true, []]]);
  assert.equal(accessOf({ permission: "control" }).mode, "control");
  assert.equal(accessOf({ permission: "weird" }).mode, "listen");
  assert.deepEqual(roleChoices([{ id: "r1", name: "Bard" }, { id: "r2", name: "Ranger" }], ["r2"]), [
    { id: "r1", name: "Bard", checked: false },
    { id: "r2", name: "Ranger", checked: true },
  ]);
  assert.deepEqual(roleChoices(undefined, []), []);
});

test("active libraries are offered only when the hello says so", async () => {
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => resolve(s));
    s.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", apiVersion: 3, features: { activeLibraries: true } })));
  });
  const c = new AudioForgeClient();
  assert.equal(c.activeLibrariesAvailable, false);
  c.configure({ host: "127.0.0.1", port: wss.address().port });
  const hello = once(c, "aiDirector");
  c.start();
  await hello;
  assert.equal(c.activeLibrariesAvailable, true);
  c.stop();
  for (const s of wss.clients) s.terminate();
  wss.close();
});
