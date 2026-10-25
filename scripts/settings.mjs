import { AudioForgeClient } from "./client.mjs";
import { defaultProfile } from "./profile.mjs";

export const MODULE_ID = "audioforge";
export const client = new AudioForgeClient();

export const getProfileSetting = (key) => game.settings.get(MODULE_ID, key) ?? defaultProfile();

export function applyConnectionSettings() {
  client.configure({
    host: game.settings.get(MODULE_ID, "host"),
    port: game.settings.get(MODULE_ID, "port"),
    apiKey: game.settings.get(MODULE_ID, "apiKey"),
  });
}

export function registerSettings(profileMenus) {
  const onChange = () => applyConnectionSettings();
  const base = { scope: "client", config: true };
  game.settings.register(MODULE_ID, "host", {
    ...base, type: String, default: "localhost", onChange,
    name: "AUDIOFORGE.Settings.Host.Name", hint: "AUDIOFORGE.Settings.Host.Hint",
  });
  game.settings.register(MODULE_ID, "port", {
    ...base, type: Number, default: 8329, onChange,
    name: "AUDIOFORGE.Settings.Port.Name", hint: "AUDIOFORGE.Settings.Port.Hint",
  });
  game.settings.register(MODULE_ID, "apiKey", {
    ...base, type: String, default: "", onChange,
    name: "AUDIOFORGE.Settings.ApiKey.Name", hint: "AUDIOFORGE.Settings.ApiKey.Hint",
  });
  game.settings.register(MODULE_ID, "autoScene", {
    ...base, type: Boolean, default: true,
    name: "AUDIOFORGE.Settings.AutoScene.Name", hint: "AUDIOFORGE.Settings.AutoScene.Hint",
  });
  game.settings.register(MODULE_ID, "autoCombat", {
    ...base, type: Boolean, default: true,
    name: "AUDIOFORGE.Settings.AutoCombat.Name", hint: "AUDIOFORGE.Settings.AutoCombat.Hint",
  });
  game.settings.register(MODULE_ID, "roomsServerUrl", {
    ...base, type: String, default: "https://rooms.audioforge.app",
    name: "AUDIOFORGE.Settings.RoomsServer.Name", hint: "AUDIOFORGE.Settings.RoomsServer.Hint",
  });
  game.settings.register(MODULE_ID, "roomAutoOpen", {
    ...base, restricted: true, type: Boolean, default: true,
    name: "AUDIOFORGE.Settings.RoomAutoOpen.Name", hint: "AUDIOFORGE.Settings.RoomAutoOpen.Hint",
  });
  game.settings.register(MODULE_ID, "roomAutoJoin", {
    ...base, type: Boolean, default: true,
    name: "AUDIOFORGE.Settings.RoomAutoJoin.Name", hint: "AUDIOFORGE.Settings.RoomAutoJoin.Hint",
  });
  game.settings.register(MODULE_ID, "roomPassword", { scope: "client", config: false, type: String, default: "" });
  // The room this player left or was removed from; auto-join stays off for it, even after a reload.
  game.settings.register(MODULE_ID, "roomOptOut", { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, "roomVolume", { scope: "client", config: false, type: Number, default: 1 });
  for (const key of ["combatStart", "combatEnd"]) {
    game.settings.register(MODULE_ID, key, { scope: "client", config: false, type: Object, default: defaultProfile() });
  }
  game.settings.registerMenu(MODULE_ID, "combatStartMenu", {
    name: "AUDIOFORGE.Settings.CombatStart.Name", label: "AUDIOFORGE.Settings.CombatStart.Label",
    icon: "fa-solid fa-swords", type: profileMenus.combatStart, restricted: true,
  });
  game.settings.registerMenu(MODULE_ID, "combatEndMenu", {
    name: "AUDIOFORGE.Settings.CombatEnd.Name", label: "AUDIOFORGE.Settings.CombatEnd.Label",
    icon: "fa-solid fa-flag-checkered", type: profileMenus.combatEnd, restricted: true,
  });
}
