import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient } from "../scripts/rooms/guest-client.mjs";
import { RemoteControlClient } from "../scripts/rooms/remote-control.mjs";
import { groupLayer, isMultiHost, libraryView, resolveAccess } from "../scripts/panel-model.mjs";
import { buildPlayerRows, findStrangers, roleChoices } from "../scripts/rooms/roster.mjs";

// Shaped like the released app: the catalog lists every library, only state.libraryUuid is playable, no activeLibraryUuids.
const libraries = [
  { uuid: "L1", name: "Core", music: [{ uuid: "m1", name: "Battle" }], ambiance: [{ uuid: "a1", name: "Rain" }, { uuid: "e1", name: "Bell", oneShot: true }] },
  { uuid: "L2", name: "Extra", music: [{ uuid: "m2", name: "Calm" }], ambiance: [{ uuid: "e2", name: "Bow", oneShot: true }] },
];
const oldState = { libraryUuid: "L1", libraryName: "Core", musicPlaying: true, musicVolume: 0.5, categoryVolume: { m1: 0.8 }, musicCategories: [{ uuid: "m1", name: "Battle" }] };
const oldCatalog = { type: "catalog", activeLibraryUuid: "L1", libraries };
const newCatalog = { type: "catalog", activeLibraryUuid: "L1", activeLibraryUuids: ["L1", "L2"], libraries };
const names = (groups) => groups.map((g) => g.categories.map((c) => c.name));

test("old host, remote player: single library select, inactive libraries are never listed", () => {
  const v = libraryView({ libraries, state: oldState, catalog: oldCatalog, remote: true, features: {} });
  assert.equal(v.multi, false);
  assert.deepEqual(v.shown.map((l) => l.uuid), ["L1"]);
  assert.deepEqual(names(groupLayer(v.shown, "Music", (c) => c)), [["Battle"]]);
  assert.deepEqual(names(groupLayer(v.shown, "Echoes", (c) => c)), [["Bell"]]);
});

test("old host, local client without features.activeLibraries: same single library", () => {
  for (const features of [undefined, {}, { aiDirector: {} }, { activeLibraries: false }]) {
    const v = libraryView({ libraries, state: oldState, catalog: oldCatalog, remote: false, features });
    assert.equal(v.multi, false);
    assert.deepEqual(v.shown.map((l) => l.uuid), ["L1"]);
  }
});

test("new host: merged libraries, for remote snapshots and for the local client", () => {
  const remote = libraryView({ libraries, state: { musicPlaying: false }, catalog: newCatalog, remote: true, features: {} });
  assert.equal(remote.multi, true);
  assert.deepEqual(names(groupLayer(remote.shown, "Music", (c) => c)), [["Battle"], ["Calm"]]);
  const local = libraryView({ libraries, state: { activeLibraryUuids: ["L2"] }, catalog: newCatalog, remote: false, features: { activeLibraries: true } });
  assert.equal(local.multi, true);
  assert.deepEqual(local.shown.map((l) => l.uuid), ["L2"]);
  assert.equal(isMultiHost({ remote: false, catalog: newCatalog, features: {} }), false); // local needs the feature flag
  assert.equal(isMultiHost({ remote: true, catalog: { libraries }, features: { activeLibraries: true } }), false); // remote needs the array
});

test("old snapshots carry no access: everything is shown", () => {
  const a = resolveAccess(undefined);
  assert.equal(a.layers.size, 3);
  assert.ok(a.stopAll && a.savedStates);
});

test("old room state renders legacy rows: listen or control only, no roles", () => {
  const users = [{ id: "u1", name: "Aria", active: true }, { id: "u2", name: "Bram", active: true }];
  const guests = [{ clientId: "c1", username: "Aria", permission: "control" }, { clientId: "c2", username: "Bram", permission: "listen" }, { clientId: "c3", username: "Link" }];
  const reports = new Map([["u1", { state: "joined", clientId: "c1" }], ["u2", { state: "joined", clientId: "c2" }]]);
  const rows = buildPlayerRows(users, reports, guests);
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.canControl, r.mode, r.isRoles, r.roleIds]), [["Aria", "joined", true, "control", false, []], ["Bram", "joined", false, "listen", false, []]]);
  const strangers = findStrangers(reports, guests);
  assert.deepEqual(strangers.map((g) => [g.username, g.canControl, g.mode]), [["Link", false, "listen"]]);
  assert.deepEqual(roleChoices(undefined, []), []); // no state.room.roles: the room manager shows no role UI
});

test("a server that never sends roles, guestId or access still works for control guests", async () => {
  let sock;
  const room = (permission) => ({ hostConnected: true, guests: [{ clientId: "c1", username: "Aria", permission }], permissions: { defaultGuestPermission: "listen", guestPermissions: {} } });
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0, path: "/ws" }, () => resolve(s));
    s.on("connection", (ws) => {
      sock = ws;
      ws.on("message", (raw) => {
        if (JSON.parse(raw.toString()).type === "guest.hello") ws.send(JSON.stringify({ type: "server.hello", clientId: "c1", role: "guest", username: "Aria", room: room("listen") }));
      });
    });
  });
  const guest = new RoomGuestClient();
  const remote = new RemoteControlClient(guest);
  const joined = new Promise((r) => guest.addEventListener("status", (ev) => ev.detail.status === "joined" && r()));
  guest.join({ baseUrl: `http://127.0.0.1:${wss.address().port}`, roomId: "R", username: "Aria", sessionId: "s", password: "" });
  await joined;
  const ready = new Promise((r) => remote.addEventListener("state", (ev) => ev.detail && r()));
  sock.send(JSON.stringify({ type: "room.state", room: room("control") }));
  sock.send(JSON.stringify({ type: "control.snapshot", snapshot: { state: oldState, catalog: oldCatalog, savedStates: [] } }));
  await ready;
  assert.equal(remote.available, true);
  assert.equal(remote.access, null);
  assert.equal(remote.catalog.activeLibraryUuids, undefined);
  guest.leave();
  for (const s of wss.clients) s.terminate();
  wss.close();
});
