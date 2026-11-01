import test from "node:test";
import assert from "node:assert/strict";
import { EchoTracker, MIN_FILL_MS, WIPE_MS } from "../scripts/echo-fill.mjs";
import { RemoteControlClient } from "../scripts/rooms/remote-control.mjs";

const e = (playbackId, extra = {}) => ({ playbackId, categoryUuid: "ghost", durationMs: 3000, positionMs: 0, remainingMs: 3000, ...extra });

test("elapsed counts from when the echo registered, minus how far in it already was", () => {
  const t = new EchoTracker();
  t.update([e("a", { positionMs: 500 })], 10_000);
  const [f] = t.fills(11_000).get("ghost");
  assert.deepEqual([f.durationMs, f.elapsedMs, f.wipeDelayMs, f.remainingMs], [3000, 1500, 1500, 1500 + WIPE_MS]);
});

test("start times survive later lists; past the duration the wipe delay turns negative", () => {
  const t = new EchoTracker();
  t.update([e("a")], 0);
  t.update([e("a", { positionMs: 2000 }), e("b")], 2000);
  assert.deepEqual(t.fills(2500).get("ghost").map((f) => [f.id, f.elapsedMs]), [["a", 2500], ["b", 500]]);
  const a = t.fills(3100).get("ghost").find((f) => f.id === "a");
  assert.deepEqual([a.elapsedMs, a.wipeDelayMs], [3100, -100]);
});

test("overlapping echoes of a category stack; others stay apart", () => {
  const t = new EchoTracker();
  t.update([e("a"), e("b"), e("c", { categoryUuid: "wind" })], 0);
  const f = t.fills(100);
  assert.equal(f.get("ghost").length, 2);
  assert.equal(f.get("wind").length, 1);
});

test("an echo that ends on time keeps its layer until the wipe is done", () => {
  const t = new EchoTracker();
  t.update([e("a")], 0);
  t.update([], 3000); // the host drops it at its end
  assert.equal(t.fills(3000 + WIPE_MS - 10).get("ghost").length, 1);
  assert.equal(t.fills(3000 + WIPE_MS + 500).size, 0);
});

test("an echo stopped early, or reported finished, disappears at once", () => {
  const t = new EchoTracker();
  t.update([e("a"), e("b")], 0);
  t.update([e("b", { remainingMs: 0 })], 500);
  assert.equal(t.fills(500).size, 0);
});

test("short and unknown-length echoes last at least MIN_FILL_MS; unknown ones hold full, then wipe once dropped", () => {
  const t = new EchoTracker();
  t.update([e("c", { durationMs: 50 }), e("d", { durationMs: null })], 0);
  assert.deepEqual(t.fills(0).get("ghost").map((x) => [x.id, x.durationMs]), [["c", MIN_FILL_MS], ["d", MIN_FILL_MS]]);
  t.update([e("d", { durationMs: null })], 100);
  const [d] = t.fills(60_000).get("ghost");
  assert.equal(d.elapsedMs, MIN_FILL_MS);
  assert.ok(d.wipeDelayMs > 1e6, "never wipes while listed");
  t.update([], 60_000);
  const [w] = t.fills(60_000).get("ghost");
  assert.equal(w.wipeDelayMs, 0, "starts wiping when dropped");
  assert.equal(t.fills(60_000 + MIN_FILL_MS + WIPE_MS + 500).size, 0);
});

test("a missed stop does not leave a known-length echo forever", () => {
  const t = new EchoTracker();
  t.update([e("a")], 0);
  assert.equal(t.fills(3000 + 2500).size, 0);
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
