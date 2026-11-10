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
      .filter((c) => layer !== "Echoes" || !!c.oneShot) // a category that is also an echo shows in both lists
      .map(pick)
      .filter(Boolean);
    if (list.length) groups.push({ uuid: lib.uuid, name: lib.name, categories: list });
  }
  return groups;
}

/** Category volume as the slider shows it: 0-1, same scale as `setVolume` (the app maps it to its 0-2 gain). */
export function categoryVolume(state, uuid) {
  const v = state?.categoryVolume?.[uuid];
  return typeof v === "number" ? Math.min(1, Math.max(0, v)) : 1;
}
