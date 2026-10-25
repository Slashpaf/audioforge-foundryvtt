import { MODULE_ID, client, registerSettings, applyConnectionSettings, getProfileSetting } from "./settings.mjs";
import { applyProfile, normalizeProfile } from "./profile.mjs";
import { notifyFailure } from "./util.mjs";
import { AudioForgePanel } from "./apps/panel.mjs";
import { ProfileEditor, CombatStartProfile, CombatEndProfile } from "./apps/profile-editor.mjs";

let panel = null;

function togglePanel(force) {
  if (panel?.rendered && force !== true) {
    panel.close();
    return;
  }
  panel ??= new AudioForgePanel();
  panel.render({ force: true });
}

// Profiles diff against live state, so they must not interleave.
let profileQueue = Promise.resolve();

function runProfile(profile) {
  if (!client.connected) return profileQueue; // Offline automation is silently skipped; the panel shows the status.
  profileQueue = profileQueue
    .then(() => applyProfile(client, profile))
    .catch(notifyFailure);
  return profileQueue;
}

async function applySceneAudio(scene = canvas?.scene) {
  if (!scene) return;
  if (!client.connected) {
    ui.notifications.warn("AUDIOFORGE.Notify.Offline", { localize: true });
    return;
  }
  await runProfile(scene.getFlag(MODULE_ID, "profile"));
}

function openSceneProfile(sceneId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  new ProfileEditor({ type: "scene", id: scene.id }, scene.name).render({ force: true });
}

/** Load the stylesheet from code with a version query so a stale cached copy can never be used. */
function loadStyles() {
  const version = game.modules.get(MODULE_ID)?.version ?? "0";
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${foundry.utils.getRoute(`modules/${MODULE_ID}/styles/module.css`)}?v=${encodeURIComponent(version)}`;
  document.head.append(link);
}

Hooks.once("init", () => {
  loadStyles();
  registerSettings({ combatStart: CombatStartProfile, combatEnd: CombatEndProfile });

  game.keybindings.register(MODULE_ID, "panel", {
    name: "AUDIOFORGE.Keybinding.Panel",
    editable: [{ key: "KeyA", modifiers: ["Alt"] }],
    onDown: () => {
      if (!game.user.isGM) return false;
      togglePanel();
      return true;
    },
  });
});

Hooks.once("ready", () => {
  const api = {
    client,
    /** Send any Local API command and resolve with its result. */
    send: (command) => client.send(command),
    play: (section, categoryName) => client.send({ command: "play", section, categoryName }),
    pause: (section) => client.send({ command: "pause", section }),
    stop: (section = "All") => client.send({ command: "stop", section }),
    playEcho: (categoryName) => client.send({ command: "playEcho", categoryName }, 12000),
    setVolume: (section, value) => client.send({ command: "setVolume", section, value }),
    setLibrary: (libraryName) => client.send({ command: "setActiveLibrary", libraryName }),
    restoreState: (name) => client.send({ command: "restoreStateByName", name }),
    applyProfile: (profile) => runProfile(normalizeProfile(profile)),
    applySceneAudio,
    openPanel: () => togglePanel(true),
  };
  game.modules.get(MODULE_ID).api = api;

  // Audio Forge runs next to the GM; players never connect.
  if (!game.user.isGM) return;

  applyConnectionSettings();
  client.addEventListener("connection", (ev) => Hooks.callAll("audioforge.connection", ev.detail));
  client.addEventListener("state", (ev) => Hooks.callAll("audioforge.state", ev.detail));
  client.start();
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const group = controls.sounds ?? Object.values(controls).at(-1);
  if (!group?.tools) return;
  group.tools.audioforge = {
    name: "audioforge",
    title: "AUDIOFORGE.Panel.Open",
    icon: "af-icon",
    button: true,
    visible: true,
    order: Object.keys(group.tools).length,
    onChange: () => togglePanel(true),
  };
});

// Scene activation -> scene profile.
Hooks.on("updateScene", (scene, changes) => {
  if (!game.user.isGM || changes.active !== true) return;
  if (!game.settings.get(MODULE_ID, "autoScene")) return;
  runProfile(scene.getFlag(MODULE_ID, "profile"));
});

// Combat start / end.
Hooks.on("combatStart", () => {
  if (!game.user.isGM || !game.settings.get(MODULE_ID, "autoCombat")) return;
  runProfile(getProfileSetting("combatStart"));
});
Hooks.on("deleteCombat", (combat) => {
  if (!game.user.isGM || !game.settings.get(MODULE_ID, "autoCombat") || !combat.started) return;
  runProfile(getProfileSetting("combatEnd"));
});

// Scene audio editor: scene config header and scene directory context menu.
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  if (!game.user.isGM || !(app instanceof foundry.applications.sheets.SceneConfig)) return;
  controls.push({
    icon: "af-icon",
    label: "AUDIOFORGE.Profile.Scene",
    action: "audioforgeProfile",
    onClick: () => openSceneProfile(app.document.id),
  });
});

function sceneContextEntry() {
  return {
    name: "AUDIOFORGE.Profile.Scene",
    icon: '<i class="af-icon"></i>',
    condition: () => game.user.isGM,
    callback: (li) => {
      const el = li instanceof HTMLElement ? li : li[0];
      openSceneProfile(el?.dataset.entryId ?? el?.dataset.documentId);
    },
  };
}
// The hook name differs between Foundry builds; registering both is harmless.
for (const name of ["getSceneContextOptions", "getSceneDirectoryEntryContext"]) {
  Hooks.on(name, (app, options) => {
    if (!options.some((o) => o.name === "AUDIOFORGE.Profile.Scene")) options.push(sceneContextEntry());
  });
}
