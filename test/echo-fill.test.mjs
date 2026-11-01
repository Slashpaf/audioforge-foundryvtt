import test from "node:test";
import assert from "node:assert/strict";
import { EchoTracker, MIN_FILL_MS } from "../scripts/echo-fill.mjs";
import { RemoteControlClient } from "../scripts/rooms/remote-control.mjs";

const e = (playbackId, extra = {}) => ({ playbackId, categoryUuid: "ghost", durationMs: 3000, positionMs: 0, remainingMs: 3000, ...extra });

test("elapsed counts from when the echo registered, minus how far in it already was", () => {
  const t = new EchoTracker();
  t.update([e("a", { positionMs: 500 })], 10_000);
  assert.deepEqual(t.fills(11_000).get("ghost"), [{ id: "a", durationMs: 3000, elapsedMs: 1500 }]);
});

test("start times survive later lists; elapsed is capped at the duration", () => {
  const t = new EchoTracker();
  t.update([e("a")], 0);
  t.update([e("a", { positionMs: 2000 }), e("b")], 2000);
  const fills = t.fills(2500).get("ghost");
  assert.deepEqual(fills.map((f) => [f.id, f.elapsedMs]), [["a", 2500], ["b", 500]]);
  assert.equal(t.fills(4000).get("ghost").find((f) => f.id === "a").elapsedMs, 3000);
});

test("overlapping echoes of a category stack; others stay apart", () => {
  const t = new EchoTracker();
  t.update([e("a"), e("b"), e("c", { categoryUuid: "wind" })], 0);
  const f = t.fills(100);
  assert.equal(f.get("ghost").length, 2);
  assert.equal(f.get("wind").length, 1);
});

test("finished, removed and zero-remaining echoes drop; short ones last at least MIN_FILL_MS", () => {
  const t = new EchoTracker();
  t.update([e("a"), e("b", { remainingMs: 0 }), e("c", { durationMs: 50 }), e("d", { durationMs: null })], 0);
  const f = t.fills(0).get("ghost");
  assert.deepEqual(f.map((x) => [x.id, x.durationMs]), [["a", 3000], ["c", MIN_FILL_MS], ["d", MIN_FILL_MS]]);
  t.update([e("d", { durationMs: null })], 100);
  assert.deepEqual(t.fills(60_000).get("ghost").map((x) => x.id), ["d"], "unknown length stays until the host drops it");
  assert.equal(t.fills(3000 + 2001 + 100).get("ghost")?.some((x) => x.id === "a") ?? false, false);
  t.update([], 200);
  assert.equal(t.fills(200).size, 0);
});

test("the remote source exposes the snapshot's echoes and tracks them", () => {
  const guest = Object.assign(new EventTarget(), { permission: "control", status: "joined", room: { hostConnected: true }, snapshot: { state: {}, catalog: {}, savedStates: [], echoes: { count: 1, echoes: [e("a")] } } });
  const remote = new RemoteControlClient(guest);
  let seen = 0;
  remote.addEventListener("echoes", () => seen++);
  guest.dispatchEvent(new Event("control"));
  assert.equal(remote.echoes.length, 1);
  assert.equal(seen, 1);
  assert.equal(remote.echoTracker.fills().get("ghost").length, 1);
  guest.snapshot = { ...guest.snapshot, echoes: undefined };
  guest.dispatchEvent(new Event("control"));
  assert.deepEqual(remote.echoes, []);
  assert.equal(remote.echoTracker.fills().size, 0);
});
