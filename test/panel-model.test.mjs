import test from "node:test";
import assert from "node:assert/strict";
import { activeLibraryUuids, categoryVolume, groupLayer, resolveAccess, shownLibraries } from "../scripts/panel-model.mjs";

const libs = [
  { uuid: "A", name: "Alpha", music: [{ uuid: "m1", name: "Battle" }], ambiance: [{ uuid: "a1", name: "Rain" }, { uuid: "e1", name: "Bell", oneShot: true }] },
  { uuid: "B", name: "Beta", music: [], ambiance: [{ uuid: "e2", name: "Bow", oneShot: true }] },
  { uuid: "C", name: "Gamma", music: [{ uuid: "m3", name: "Calm" }], ambiance: [] },
];

test("access: absent is full, roles fails closed, full mode defaults to everything", () => {
  const all = resolveAccess(null);
  assert.deepEqual([...all.layers], ["Music", "Ambiance", "Echoes"]);
  assert.equal(all.stopAll && all.savedStates, true);
  const roles = resolveAccess({ mode: "roles", fullLayers: ["Echoes"] });
  assert.deepEqual([...roles.layers], ["Echoes"]);
  assert.equal(roles.stopAll, false);
  assert.equal(roles.savedStates, false);
  assert.equal(resolveAccess({ mode: "roles", fullLayers: [], stopAll: true }).stopAll, true);
  const full = resolveAccess({ mode: "full", fullLayers: ["Music", "Ambiance", "Echoes"], stopAll: true, savedStates: true, libraries: false });
  assert.equal(full.layers.size, 3);
  assert.equal(resolveAccess({ mode: "full", fullLayers: [], stopAll: false }).stopAll, false);
});

test("remote players see every library, the GM only the active ones (or the single selected one)", () => {
  assert.equal(shownLibraries({ libraries: libs, remote: true }).length, 3);
  const state = { activeLibraryUuids: ["A", "C"] };
  assert.deepEqual(shownLibraries({ libraries: libs, state, multi: true }).map((l) => l.uuid), ["A", "C"]);
  assert.deepEqual(shownLibraries({ libraries: libs, state: { libraryUuid: "B" } }).map((l) => l.uuid), ["B"]);
  assert.deepEqual(shownLibraries({ libraries: libs, state: {}, catalog: {} }).map((l) => l.uuid), ["A"]);
  assert.equal(activeLibraryUuids({}, { activeLibraryUuids: ["B"] })[0], "B");
  assert.equal(activeLibraryUuids({}, {}), null);
});

test("layers are grouped per library, empty groups dropped, echoes are the one-shot ambiance", () => {
  const id = (c) => c;
  assert.deepEqual(groupLayer(libs, "Music", id).map((g) => g.name), ["Alpha", "Gamma"]);
  assert.deepEqual(groupLayer(libs, "Ambiance", id).map((g) => g.categories.map((c) => c.name)), [["Rain", "Bell"], ["Bow"]]);
  assert.deepEqual(groupLayer(libs, "Echoes", id).map((g) => g.categories.map((c) => c.name)), [["Bell"], ["Bow"]]);
});

test("category volume is the 0-1 value of the state, 1 when unknown", () => {
  assert.equal(categoryVolume({ categoryVolume: { x: 0.25 } }, "x"), 0.25);
  assert.equal(categoryVolume({ categoryVolume: { x: 7 } }, "x"), 1);
  assert.equal(categoryVolume({}, "x"), 1);
});
