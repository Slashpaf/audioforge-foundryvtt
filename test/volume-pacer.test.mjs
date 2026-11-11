import test from "node:test";
import assert from "node:assert/strict";
import { VolumePacer, clampCategoryVolume } from "../scripts/volume-pacer.mjs";

test("volume bursts are coalesced per section and category, the newest value wins", async () => {
  const pacer = new VolumePacer();
  const sent = [];
  const sendNow = async (c) => {
    sent.push(c);
    return { ok: true };
  };
  const calls = [];
  for (let i = 0; i < 50; i++) calls.push(pacer.send({ command: "setVolume", section: "Music", categoryUuid: "a", value: i / 100 }, sendNow));
  calls.push(pacer.send({ command: "setVolume", section: "Music", categoryUuid: "b", value: 0.5 }, sendNow));
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok));
  const a = sent.filter((c) => c.categoryUuid === "a");
  assert.ok(a.length >= 1 && a.length <= 2, `sent ${a.length}`);
  assert.equal(a.at(-1).value, 0.49);
  assert.equal(sent.filter((c) => c.categoryUuid === "b").length, 1);
});

test("a category value never goes above display 0.5, a section value is untouched", async () => {
  const pacer = new VolumePacer();
  const sent = [];
  const sendNow = async (c) => (sent.push(c), { ok: true });
  await pacer.send({ command: "setVolume", section: "Music", categoryUuid: "a", value: 1 }, sendNow);
  await pacer.send({ command: "setVolume", section: "Music", categoryUuid: "b", value: Number.NaN }, sendNow);
  await pacer.send({ command: "setVolume", section: "Music", value: 1 }, sendNow);
  assert.deepEqual(sent.map((c) => c.value), [0.5, 0, 1]);
  assert.equal(clampCategoryVolume("0.3"), 0.3);
});
