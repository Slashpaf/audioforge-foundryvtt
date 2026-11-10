import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RoomGuestClient } from "../scripts/rooms/guest-client.mjs";
import { resetRoomSessionId, roomSessionId } from "../scripts/util.mjs";
import { buildPlayerRows, findStrangers } from "../scripts/rooms/roster.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const statusIs = (c, status) =>
  new Promise((resolve) => {
    const on = (ev) => {
      if (ev.detail.status !== status) return;
      c.removeEventListener("status", on);
      resolve(ev.detail);
    };
    c.addEventListener("status", on);
  });

/** Rooms server stand-in. `features` and `resumed` go into server.hello; `canForget` makes it answer guest.forget. */
async function startServer({ features, resumed, canForget }) {
  const hellos = [];
  const forgets = [];
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0, path: "/ws" }, () => resolve(s));
    s.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "guest.hello") {
          hellos.push(msg);
          const extra = { ...(features ? { features } : {}), ...(resumed ? { resumed: true } : {}) };
          ws.send(JSON.stringify({ type: "server.hello", clientId: `c${hellos.length}`, role: "guest", username: "Aria", room: { guests: [], maxGuests: 5 }, ...extra }));
        } else if (msg.type === "guest.forget" && canForget) {
          forgets.push(msg);
          ws.close(4000, "guest_forgotten");
        }
      });
    });
  });
  return { wss, hellos, forgets };
}
const cfg = (wss, sessionId = "s1") => ({ baseUrl: `http://127.0.0.1:${wss.address().port}`, roomId: "R", username: "Aria", sessionId, password: "" });
const stop = (c, wss) => {
  c.leave();
  for (const s of wss.clients) s.terminate();
  wss.close();
};

test("features and resumed from server.hello are exposed", async () => {
  const { wss } = await startServer({ features: { guestForget: true }, resumed: true });
  const c = new RoomGuestClient();
  assert.equal(c.resumed, false);
  const joined = statusIs(c, "joined");
  c.join(cfg(wss));
  await joined;
  assert.equal(c.features.guestForget, true);
  assert.equal(c.resumed, true);
  stop(c, wss);
});

test("forget closes cleanly: resolves true, no error, no reconnect loop", async () => {
  const { wss, hellos, forgets } = await startServer({ features: { guestForget: true }, canForget: true });
  const c = new RoomGuestClient();
  const joined = statusIs(c, "joined");
  c.join(cfg(wss));
  await joined;
  const statuses = [];
  c.addEventListener("status", (ev) => statuses.push(ev.detail.status));
  assert.equal(await c.forget(), true);
  await wait(1500); // longer than the first retry delay
  assert.equal(forgets.length, 1);
  assert.equal(hellos.length, 1);
  assert.equal(c.status, "idle");
  assert.equal(c.clientId, null);
  assert.ok(!statuses.includes("error") && !statuses.includes("connecting"), statuses.join());
  stop(c, wss);
});

test("an old server (no features) is never sent guest.forget", async () => {
  const { wss, forgets } = await startServer({ canForget: true });
  const c = new RoomGuestClient();
  const joined = statusIs(c, "joined");
  c.join(cfg(wss));
  await joined;
  assert.equal(await c.forget(), false);
  assert.equal(c.status, "joined"); // untouched: the caller falls back to leave
  await wait(50);
  assert.equal(forgets.length, 0);
  stop(c, wss);
});

test("start anew against an old server: leave, new session id, rejoin as a new guest", async () => {
  const { wss, hellos } = await startServer({});
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const first = roomSessionId(storage, "k");
  const c = new RoomGuestClient();
  let joined = statusIs(c, "joined");
  c.join(cfg(wss, first));
  await joined;
  // What RoomSession.startAnew does.
  if (!(await c.forget())) c.leave();
  const second = resetRoomSessionId(storage, "k");
  assert.notEqual(second, first);
  assert.equal(roomSessionId(storage, "k"), second);
  joined = statusIs(c, "joined");
  c.join(cfg(wss, second));
  await joined;
  assert.deepEqual(hellos.map((h) => h.sessionId), [first, second]);
  stop(c, wss);
});

test("resetRoomSessionId survives blocked storage", () => {
  const blocked = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
  assert.match(resetRoomSessionId(blocked, "k"), /^fvtt-/);
  assert.match(resetRoomSessionId(undefined, "k"), /^fvtt-/);
});

test("roster: a player who started anew is one row with the new clientId, the old session is gone", () => {
  const users = [{ id: "u1", name: "Aria", active: true }];
  const before = [{ clientId: "c1", username: "Aria", permission: "roles", roleIds: ["r"], roleNames: ["Bard"] }];
  const after = [{ clientId: "c2", username: "Aria", permission: "listen" }];
  let rows = buildPlayerRows(users, new Map([["u1", { state: "joined", clientId: "c1" }]]), before);
  assert.equal(rows[0].mode, "roles");
  // Between the player's report of the new session and the server dropping the old one, the old guest is a stranger for a moment.
  const reports = new Map([["u1", { state: "joined", clientId: "c2" }]]);
  assert.deepEqual(findStrangers(reports, [...before, ...after]).map((g) => g.clientId), ["c1"]);
  rows = buildPlayerRows(users, reports, after);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].clientId, rows[0].mode, rows[0].isRoles], ["c2", "listen", false]);
  assert.deepEqual(findStrangers(reports, after), []);
});
