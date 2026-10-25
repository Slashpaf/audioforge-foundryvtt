import test from "node:test";
import assert from "node:assert/strict";
import { applyProfile, normalizeProfile } from "../scripts/profile.mjs";

const fakeClient = (state) => {
  const sent = [];
  return { state, sent, send: async (c) => void sent.push(c) };
};

test("normalizeProfile repairs junk", () => {
  const p = normalizeProfile({ mode: "bogus", ambiance: [null, { uuid: "a" }], music: {} });
  assert.equal(p.mode, "none");
  assert.deepEqual(p.ambiance, [{ uuid: "a" }]);
  assert.equal(p.music, null);
});

test("none sends nothing", async () => {
  const c = fakeClient({});
  assert.deepEqual(await applyProfile(c, { mode: "none" }), []);
});

test("state mode restores by id", async () => {
  const c = fakeClient({});
  await applyProfile(c, { mode: "state", stateId: "s1" });
  assert.deepEqual(c.sent, [{ command: "restoreStateById", id: "s1" }]);
});

test("categories: skips already-playing, stops unwanted, never toggles ambiance on", async () => {
  const c = fakeClient({
    musicCategories: [{ uuid: "m1" }],
    ambianceCategories: [{ uuid: "rain" }, { uuid: "wind" }],
  });
  await applyProfile(c, {
    mode: "categories",
    music: { uuid: "m1", name: "Battle" },
    ambiance: [{ uuid: "rain", name: "Rain" }, { uuid: "cave", name: "Cave" }],
    stopAmbiance: true,
  });
  assert.deepEqual(c.sent.map((x) => [x.command, x.categoryUuid, x.enabled]), [
    ["setCategoryEnabled", "wind", false],
    ["setCategoryEnabled", "cave", true],
  ]);
});

test("categories: plays new music, stopMusic when none chosen", async () => {
  const a = fakeClient({ musicCategories: [], ambianceCategories: [] });
  await applyProfile(a, { mode: "categories", music: { uuid: "m2", name: "Tavern" } });
  assert.equal(a.sent[0].command, "play");
  const b = fakeClient({ musicCategories: [{ uuid: "x" }], ambianceCategories: [] });
  await applyProfile(b, { mode: "categories", stopMusic: true });
  assert.deepEqual(b.sent, [{ command: "stop", section: "Music" }]);
});

test("library switch skipped when already active", async () => {
  const c = fakeClient({ libraryUuid: "L1" });
  await applyProfile(c, { mode: "state", stateId: "s", libraryUuid: "L1" });
  assert.equal(c.sent.length, 1);
});

test("categories: loaded-but-paused section counts as not playing", async () => {
  const c = fakeClient({
    musicPlaying: false, musicCategories: [{ uuid: "m1" }],
    ambiancePlaying: false, ambianceCategories: [{ uuid: "rain" }, { uuid: "wind" }],
  });
  await applyProfile(c, {
    mode: "categories",
    music: { uuid: "m1", name: "Battle" },
    ambiance: [{ uuid: "rain", name: "Rain" }],
    stopAmbiance: true,
  });
  assert.deepEqual(c.sent.map((x) => [x.command, x.categoryUuid, x.enabled]), [
    ["play", "m1", undefined],
    ["setCategoryEnabled", "wind", false],
    ["setCategoryEnabled", "rain", true],
  ]);
});
