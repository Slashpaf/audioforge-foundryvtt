import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { AudioForgeClient } from "../scripts/client.mjs";
import { editorToRole, emptyEditor, groupCatalog, layerOf, roleSummary, roleToEditor, unknownSelection, validateEditor } from "../scripts/roles-model.mjs";

const catalog = {
  libraries: [
    {
      uuid: "L1", name: "Core",
      music: [{ uuid: "m1", name: "Battle" }, { uuid: "m2", name: "Calm" }],
      ambiance: [{ uuid: "a1", name: "Rain" }, { uuid: "e1", name: "Bell", oneShot: true }],
    },
    { uuid: "L2", name: "Tavern <b>", music: [], ambiance: [{ uuid: "e2", name: "Bow", oneShot: true }] },
    { uuid: "L3", name: "Empty", music: [], ambiance: [] },
  ],
};

test("layers: music section is Music, one-shot ambiance is Echoes", () => {
  assert.equal(layerOf("music", {}), "Music");
  assert.equal(layerOf("ambiance", {}), "Ambiance");
  assert.equal(layerOf("ambiance", { oneShot: true }), "Echoes");
});

test("role <-> editor round trip, ids only for existing roles", () => {
  const role = { id: "r1", name: "Bard", fullLayers: ["Echoes", "Music", "Nope"], libraryUuids: ["L1", "L1"], categoryUuids: ["m1"] };
  const ed = roleToEditor(role);
  assert.deepEqual(ed.fullLayers, ["Music", "Echoes"]);
  assert.deepEqual(editorToRole({ ...ed, name: "  Bard  " }), { id: "r1", name: "Bard", fullLayers: ["Music", "Echoes"], libraryUuids: ["L1"], categoryUuids: ["m1"] });
  assert.equal("id" in editorToRole({ ...emptyEditor(), name: "New" }), false);
  assert.deepEqual(roleToEditor(undefined), { id: undefined, name: "", fullLayers: [], libraryUuids: [], categoryUuids: [] });
});

test("validation: name 1-40 characters", () => {
  assert.deepEqual(validateEditor({ name: "   " }), ["nameEmpty"]);
  assert.deepEqual(validateEditor({ name: "x".repeat(41) }), ["nameTooLong"]);
  assert.deepEqual(validateEditor({ name: "x".repeat(40) }), []);
});

test("summary counts layers, libraries and categories", () => {
  assert.deepEqual(roleSummary({ fullLayers: ["Music", "Echoes"], libraryUuids: [], categoryUuids: ["a", "b", "c"] }), { layers: ["Music", "Echoes"], libraries: 0, categories: 3 });
  assert.deepEqual(roleSummary({}), { layers: [], libraries: 0, categories: 0 });
});

test("catalog grouped by library then layer, with selected counts; empty libraries dropped", () => {
  const groups = groupCatalog(catalog, { selected: new Set(["m1", "e1"]) });
  assert.deepEqual(groups.map((g) => g.name), ["Core", "Tavern <b>"]);
  assert.deepEqual(groups[0].layers.map((l) => [l.layer, l.categories.map((c) => c.name), l.selectedCount]), [["Music", ["Battle", "Calm"], 1], ["Ambiance", ["Rain"], 0], ["Echoes", ["Bell"], 1]]);
  assert.equal(groups[0].selectedCount, 2);
  assert.deepEqual(groups[1].layers.map((l) => l.layer), ["Echoes"]);
});

test("search filters by category name, or keeps a whole library when its name matches", () => {
  assert.deepEqual(groupCatalog(catalog, { query: "RAIN" }).map((g) => g.layers.flatMap((l) => l.categories.map((c) => c.name))), [["Rain"]]);
  assert.deepEqual(groupCatalog(catalog, { query: "tavern" })[0].layers[0].categories.map((c) => c.name), ["Bow"]);
  assert.deepEqual(groupCatalog(catalog, { query: "zzz" }), []);
  assert.deepEqual(groupCatalog(undefined), []);
});

test("selections that left the catalog are reported so a save keeps them", () => {
  assert.deepEqual(unknownSelection(catalog, ["m1", "gone"], "category"), ["gone"]);
  assert.deepEqual(unknownSelection(catalog, ["L2", "gone"], "library"), ["gone"]);
});

async function startApp(handlers, features) {
  const calls = [];
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0 }, () => resolve(s));
    s.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "hello", apiVersion: 3, features }));
      ws.on("message", (raw) => {
        const cmd = JSON.parse(raw.toString());
        calls.push(cmd);
        try {
          ws.send(JSON.stringify({ type: "result", ok: true, requestId: cmd.requestId, ...(handlers[cmd.command]?.(cmd) ?? {}) }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", ok: false, error: err.message, requestId: cmd.requestId }));
        }
      });
    });
  });
  const c = new AudioForgeClient();
  c.configure({ host: "127.0.0.1", port: wss.address().port });
  const hello = new Promise((r) => c.addEventListener("aiDirector", () => r(), { once: true }));
  c.start();
  await hello;
  const stop = () => {
    c.stop();
    for (const s of wss.clients) s.terminate();
    wss.close();
  };
  return { c, calls, stop };
}

test("local API: roles are offered only with features.roomControl.roles, list/save/delete use the documented commands", async () => {
  const stored = [{ id: "r1", name: "Bard", fullLayers: ["Music"], libraryUuids: [], categoryUuids: [] }];
  const { c, calls, stop } = await startApp(
    {
      listRoomRoles: () => ({ roles: stored }),
      saveRoomRole: (cmd) => ({ role: { id: cmd.role.id ?? "r2", ...cmd.role } }),
      deleteRoomRole: () => ({}),
    },
    { roomControl: { commands: ["play"], roles: true } },
  );
  assert.equal(c.roomRolesAvailable, true);
  assert.deepEqual(await c.listRoomRoles(), stored);
  const created = await c.saveRoomRole({ name: "Ranger", fullLayers: [], libraryUuids: [], categoryUuids: ["e1"] });
  assert.equal(created.id, "r2");
  await c.saveRoomRole({ id: "r1", name: "Bard 2", fullLayers: ["Music"], libraryUuids: [], categoryUuids: [] });
  await c.deleteRoomRole("r1");
  assert.deepEqual(calls.map((x) => x.command), ["listRoomRoles", "saveRoomRole", "saveRoomRole", "deleteRoomRole"]);
  assert.equal("id" in calls[1].role, false);
  assert.equal(calls[2].role.id, "r1");
  assert.equal(calls[3].id, "r1");
  stop();
});

test("an old app (no roles feature) offers no roles; errors reject", async () => {
  const { c, stop } = await startApp({ listRoomRoles: () => { throw new Error("unknown command"); } }, { aiDirector: {}, roomControl: { commands: [] } });
  assert.equal(c.roomRolesAvailable, false);
  await assert.rejects(c.listRoomRoles(), /unknown command/);
  stop();
});
