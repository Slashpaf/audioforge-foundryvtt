import test from "node:test";
import assert from "node:assert/strict";
import { buildPlayerRows, findStrangers, takeNewRejections } from "../scripts/rooms/roster.mjs";

const users = [
  { id: "u1", name: "Aria", active: true },
  { id: "u2", name: "Bram", active: true },
  { id: "u3", name: "Cleo", active: false },
];

test("rows reflect player reports, checked against who the server says is connected", () => {
  const reports = new Map([
    ["u1", { state: "joined", clientId: "c1" }],
    ["u2", { state: "waiting", clientId: null }],
  ]);
  const rows = buildPlayerRows(users, reports, [{ clientId: "c1", username: "Aria" }]);
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.clientId]), [["Aria", "joined", "c1"], ["Bram", "waiting", null], ["Cleo", "offline", null]]);
});

test("a player who says joined but is gone from the server is not shown as joined", () => {
  const reports = new Map([["u1", { state: "joined", clientId: "c1" }]]);
  const [row] = buildPlayerRows(users, reports, []);
  assert.equal(row.state, "idle");
  assert.equal(row.clientId, null);
});

test("strangers are connected guests that no player claims", () => {
  const reports = new Map([["u1", { state: "joined", clientId: "c1" }]]);
  const guests = [{ clientId: "c1", username: "Aria" }, { clientId: "c9", username: "Guest-4" }];
  assert.deepEqual(findStrangers(reports, guests).map((g) => g.clientId), ["c9"]);
});

test("each rejection is reported once", () => {
  const seen = new Set();
  const a = { username: "Bram", rejectedAt: "2026-01-01T00:00:00Z" };
  assert.equal(takeNewRejections([a], seen).length, 1);
  assert.equal(takeNewRejections([a], seen).length, 0);
  assert.equal(takeNewRejections([a, { username: "Bram", rejectedAt: "2026-01-01T00:01:00Z" }], seen).length, 1);
});

test("rows and strangers carry whether the guest may control Audio Forge", () => {
  const guests = [
    { clientId: "c1", username: "Aria", permission: "control" },
    { clientId: "c2", username: "Bram", permission: "listen" },
    { clientId: "c9", username: "Link", permission: "control" },
  ];
  const reports = new Map([["u1", { state: "joined", clientId: "c1" }], ["u2", { state: "joined", clientId: "c2" }]]);
  const rows = buildPlayerRows(users, reports, guests);
  assert.deepEqual(rows.map((r) => [r.name, r.canControl]), [["Aria", true], ["Bram", false], ["Cleo", false]]);
  assert.deepEqual(findStrangers(reports, guests).map((g) => [g.username, g.canControl]), [["Link", true]]);
});
