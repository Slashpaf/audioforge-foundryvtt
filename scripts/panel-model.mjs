/**
 * Pure helpers for the control panel: which libraries are shown and what the host lets this client use.
 * No Foundry dependencies so they can be tested under Node.
 */

const LAYERS = ["Music", "Ambiance", "Echoes"];

/**
 * What this client may use. `access` is `snapshot.access` from the host (remote players only); absent means everything,
 * as before roles existed. A roles-mode access fails closed: only what it lists.
 */
export function resolveAccess(access) {
  if (!access || typeof access !== "object") return { layers: new Set(LAYERS), stopAll: true, savedStates: true };
  const full = access.mode === "full";
  const listed = Array.isArray(access.fullLayers) ? access.fullLayers : [];
  return {
    layers: new Set(full && !listed.length ? LAYERS : listed),
    stopAll: full ? access.stopAll !== false : access.stopAll === true,
    savedStates: full ? access.savedStates !== false : access.savedStates === true,
  };
}

/** Uuids of the libraries in use: the app's list, else the single active one, else null (unknown: show all). */
export function activeLibraryUuids(state, catalog) {
  const list = state?.activeLibraryUuids ?? catalog?.activeLibraryUuids;
  if (Array.isArray(list) && list.length) return list;
  const one = state?.libraryUuid || catalog?.activeLibraryUuid;
  return one ? [one] : null;
}

/**
 * Whether the host can run several active libraries and says which are active. An older host lists every library in
 * the catalog although only one is playable, so the merged view is only for hosts that advertise it:
 * remote snapshots by `catalog.activeLibraryUuids` (an array), the local client by `features.activeLibraries`.
 */
export function isMultiHost({ remote, catalog, features }) {
  return remote ? Array.isArray(catalog?.activeLibraryUuids) : features?.activeLibraries === true;
}

/**
 * The library part of the panel. `multi`: merged view of the active libraries (players: all libraries of the snapshot),
 * no library select for players, checkboxes for the GM. Not `multi`: the old behaviour, one library and a select.
 */
export function libraryView({ libraries, state, catalog, remote, features }) {
  const multi = isMultiHost({ remote, catalog, features });
  const shown = shownLibraries({ libraries, state, catalog, remote: remote && multi, multi: !remote && multi });
  return { multi, shown, active: activeLibraryUuids(state, catalog) ?? (libraries ?? []).map((l) => l.uuid) };
}

/**
 * Libraries whose categories the panel lists.
 *  - remote player: every library of the snapshot (the host already limited it to what this guest may use)
 *  - local, several active libraries supported: the active ones
 *  - local, single library select: the selected one
 */
export function shownLibraries({ libraries, state, catalog, remote, multi }) {
  const libs = libraries ?? [];
  if (remote) return libs;
  if (multi) {
    const active = activeLibraryUuids(state, catalog);
    return active ? libs.filter((l) => active.includes(l.uuid)) : libs;
  }
  const uuid = state?.libraryUuid || catalog?.activeLibraryUuid;
  const lib = libs.find((l) => l.uuid === uuid) ?? libs[0];
  return lib ? [lib] : [];
}

/** `[{ uuid, name, categories }]` of one layer, one group per library, empty groups dropped. `pick` filters and maps a category. */
export function groupLayer(libs, layer, pick) {
  const groups = [];
  for (const lib of libs) {
    const list = (lib?.[layer === "Music" ? "music" : "ambiance"] ?? [])
      .filter((c) => layer === "Music" || (layer === "Echoes") === !!c.oneShot) // one-shot ambiance categories are echoes
      .map(pick)
      .filter(Boolean);
    if (list.length) groups.push({ uuid: lib.uuid, name: lib.name, categories: list });
  }
  return groups;
}

/**
 * Category volume as the slider shows it: 0-1, same scale as `setVolume` (the app maps it to its 0-2 gain).
 * The live value when the category is loaded, else the catalog entry's `volume`, else the middle.
 */
export function categoryVolume(state, uuid, category) {
  const v = state?.categoryVolume?.[uuid] ?? category?.volume;
  return typeof v === "number" ? Math.min(1, Math.max(0, v)) : 0.5;
}
