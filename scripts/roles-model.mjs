/**
 * Pure logic of the roles window: role <-> editor state, validation, summary, layer classification and the
 * filtered, grouped category list. No Foundry dependencies so it can be tested under Node.
 *
 * A role (Local API): { id, name, fullLayers: ["Music"|"Ambiance"|"Echoes"], libraryUuids: [], categoryUuids: [] }.
 */

export const LAYERS = ["Music", "Ambiance", "Echoes"];
export const NAME_MAX = 40;

/** The layer of a catalog category: Music section = Music; Ambiance section, one-shot = Echoes, else Ambiance. */
export function layerOf(section, category) {
  if (section === "music") return "Music";
  return category?.oneShot ? "Echoes" : "Ambiance";
}

const unique = (list) => [...new Set((Array.isArray(list) ? list : []).filter((v) => typeof v === "string" && v))];

export function emptyEditor() {
  return { id: undefined, name: "", fullLayers: [], libraryUuids: [], categoryUuids: [] };
}

/** Editor state from a role of the app (also copes with missing fields). */
export function roleToEditor(role) {
  return {
    id: role?.id,
    name: typeof role?.name === "string" ? role.name : "",
    fullLayers: LAYERS.filter((l) => (role?.fullLayers ?? []).includes(l)),
    libraryUuids: unique(role?.libraryUuids),
    categoryUuids: unique(role?.categoryUuids),
  };
}

/** Validation errors of an editor state: a list of codes (empty = valid). */
export function validateEditor(editor) {
  const errors = [];
  const name = String(editor?.name ?? "").trim();
  if (!name) errors.push("nameEmpty");
  else if (name.length > NAME_MAX) errors.push("nameTooLong");
  return errors;
}

/** The `role` of saveRoomRole: no `id` for a new role. */
export function editorToRole(editor) {
  const role = {
    name: String(editor.name ?? "").trim(),
    fullLayers: LAYERS.filter((l) => (editor.fullLayers ?? []).includes(l)),
    libraryUuids: unique(editor.libraryUuids),
    categoryUuids: unique(editor.categoryUuids),
  };
  return editor.id ? { id: editor.id, ...role } : role;
}

/** Numbers behind a one-line summary such as "Music, Echoes, 3 categories". */
export function roleSummary(role) {
  const e = roleToEditor(role);
  return { layers: e.fullLayers, libraries: e.libraryUuids.length, categories: e.categoryUuids.length };
}

/**
 * Catalog for the pickers: libraries, each with its categories split by layer, filtered by `query` (case insensitive,
 * on the category name) and marked with `selected`. Empty layers and libraries are dropped. A library name that
 * matches the query keeps all of its categories.
 */
export function groupCatalog(catalog, { query = "", selected = new Set() } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  const out = [];
  for (const lib of catalog?.libraries ?? []) {
    const libMatches = !!q && String(lib.name ?? "").toLowerCase().includes(q);
    const layers = LAYERS.map((layer) => ({ layer, categories: [] }));
    for (const section of ["music", "ambiance"]) {
      for (const c of lib[section] ?? []) {
        if (!c?.uuid) continue;
        const name = String(c.name ?? "");
        if (q && !libMatches && !name.toLowerCase().includes(q)) continue;
        layers[LAYERS.indexOf(layerOf(section, c))].categories.push({ uuid: c.uuid, name, selected: selected.has(c.uuid) });
      }
    }
    const shown = layers.filter((l) => l.categories.length).map((l) => ({ ...l, selectedCount: l.categories.filter((c) => c.selected).length }));
    if (shown.length) out.push({ uuid: lib.uuid, name: lib.name, layers: shown, selectedCount: shown.reduce((n, l) => n + l.selectedCount, 0) });
  }
  return out;
}

/** Selected uuids that are not in the catalog any more (kept on save so editing does not silently drop them). */
export function unknownSelection(catalog, uuids, kind) {
  const known = new Set();
  for (const lib of catalog?.libraries ?? []) {
    if (kind === "library") known.add(lib.uuid);
    else for (const section of ["music", "ambiance"]) for (const c of lib[section] ?? []) known.add(c.uuid);
  }
  return uuids.filter((u) => !known.has(u));
}
