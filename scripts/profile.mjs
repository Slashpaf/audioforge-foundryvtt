/**
 * An "audio profile" says what Audio Forge should do when a trigger fires
 * (scene activation, combat start, combat end, or a manual apply).
 * Pure logic with no Foundry dependencies.
 */

export const PROFILE_MODES = ["none", "state", "categories"];

export function defaultProfile() {
  return {
    mode: "none",
    // mode "state": a saved Audio Forge state, restored by id (name kept as a label and fallback).
    stateId: "",
    stateName: "",
    // mode "categories": explicit music/ambiance selection from the active library.
    music: null, // { uuid, name } | null
    ambiance: [], // [{ uuid, name }]
    stopMusic: false, // stop Music when no music category is chosen
    stopAmbiance: true, // stop ambiance categories that are not in the selection
    stopEchoes: false,
    libraryUuid: "",
    libraryName: "",
  };
}

export function normalizeProfile(raw) {
  const base = defaultProfile();
  if (!raw || typeof raw !== "object") return base;
  const p = { ...base, ...raw };
  if (!PROFILE_MODES.includes(p.mode)) p.mode = "none";
  p.ambiance = Array.isArray(p.ambiance) ? p.ambiance.filter((c) => c?.uuid) : [];
  p.music = p.music?.uuid ? p.music : null;
  return p;
}

export function describeProfile(profile) {
  const p = normalizeProfile(profile);
  if (p.mode === "state") return p.stateName || p.stateId || "";
  if (p.mode === "categories") {
    return [p.music?.name, ...p.ambiance.map((c) => c.name)].filter(Boolean).join(", ");
  }
  return "";
}

const uuidsOf = (list) => new Set((list ?? []).map((c) => c.uuid));

/**
 * Run a profile against a connected client.
 * Ambiance `play` toggles in Audio Forge, so ambiance changes always use
 * setCategoryEnabled with an explicit target and skip categories already in the wanted state.
 * Returns the list of commands that were sent (useful for tests and logging).
 */
export async function applyProfile(client, profileRaw) {
  const p = normalizeProfile(profileRaw);
  const sent = [];
  const run = async (cmd) => {
    sent.push(cmd);
    await client.send(cmd);
  };

  if (p.mode === "none") return sent;

  if (p.libraryUuid || p.libraryName) {
    const active = client.state?.libraryUuid;
    if (!(p.libraryUuid && p.libraryUuid === active)) {
      const fresh = client.nextState?.();
      await run(p.libraryUuid
        ? { command: "setActiveLibrary", libraryUuid: p.libraryUuid }
        : { command: "setActiveLibrary", libraryName: p.libraryName });
      await fresh;
    }
  }

  if (p.mode === "state") {
    if (p.stateId) await run({ command: "restoreStateById", id: p.stateId });
    else if (p.stateName) await run({ command: "restoreStateByName", name: p.stateName });
    return sent;
  }

  // mode === "categories"
  const state = client.state ?? {};
  // The state lists categories that are loaded, including ones in a paused section.
  const loadedAmbiance = uuidsOf(state.ambianceCategories);
  const loadedMusic = uuidsOf(state.musicCategories);
  const playingMusic = state.musicPlaying === false ? new Set() : loadedMusic;
  const playingAmbiance = state.ambiancePlaying === false ? new Set() : loadedAmbiance;
  const wantedAmbiance = uuidsOf(p.ambiance);

  if (p.music) {
    if (!playingMusic.has(p.music.uuid)) {
      await run({ command: "play", section: "Music", categoryUuid: p.music.uuid, categoryName: p.music.name });
    }
  } else if (p.stopMusic && loadedMusic.size) {
    await run({ command: "stop", section: "Music" });
  }

  if (p.stopAmbiance) {
    for (const uuid of loadedAmbiance) {
      if (!wantedAmbiance.has(uuid)) {
        await run({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: uuid, enabled: false });
      }
    }
  }
  for (const cat of p.ambiance) {
    if (!playingAmbiance.has(cat.uuid)) {
      await run({ command: "setCategoryEnabled", section: "Ambiance", categoryUuid: cat.uuid, categoryName: cat.name, enabled: true });
    }
  }

  if (p.stopEchoes) await run({ command: "stop", section: "Echoes" });
  return sent;
}
