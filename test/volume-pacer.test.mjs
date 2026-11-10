import test from "node:test";
import assert from "node:assert/strict";
import { VolumePacer } from "../scripts/volume-pacer.mjs";

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
