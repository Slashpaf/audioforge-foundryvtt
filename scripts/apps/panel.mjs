import { MODULE_ID, client } from "../settings.mjs";
import { DOWNLOAD_URL, isRegular, notifyFailure } from "../util.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SECTIONS = ["Music", "Ambiance"];

/** Mirrors the app's own lists: categories with no tracks are hidden. */
const usable = (c) => c.trackCount !== 0;

/** GM control panel mirroring Audio Forge's live state. */
export class AudioForgePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "audioforge-panel",
    classes: ["audioforge", "audioforge-panel"],
    position: { width: 380, height: "auto" },
    window: { title: "AUDIOFORGE.Title", icon: "af-icon", resizable: true },
    actions: {
      toggleSection: AudioForgePanel.#onToggleSection,
      stopSection: AudioForgePanel.#onStopSection,
      nextTrack: AudioForgePanel.#onNextTrack,
      toggleCategory: AudioForgePanel.#onToggleCategory,
      echo: AudioForgePanel.#onEcho,
      restoreState: AudioForgePanel.#onRestoreState,
      stopAll: AudioForgePanel.#onStopAll,
      applyScene: AudioForgePanel.#onApplyScene,
      openRoom: AudioForgePanel.#onOpenRoom,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/panel.hbs` } };

  #refresh = () => this.#scheduleRender();
  #renderTimer = null;
  #dragging = false;

  #scheduleRender() {
    if (!this.rendered) return;
    clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => {
      // Do not rebuild the DOM under a slider the user is dragging; retry after release.
      if (this.#dragging) return this.#scheduleRender();
      this.render();
    }, 80);
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    for (const ev of ["connection", "blocked", "state", "catalog", "savedStates"]) client.addEventListener(ev, this.#refresh);
  }

  _onClose(options) {
    clearTimeout(this.#renderTimer);
    for (const ev of ["connection", "blocked", "state", "catalog", "savedStates"]) client.removeEventListener(ev, this.#refresh);
    super._onClose?.(options);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    for (const input of this.element.querySelectorAll("input[type=range][data-section]")) {
      input.addEventListener("pointerdown", () => (this.#dragging = true));
      input.addEventListener("pointerup", () => (this.#dragging = false));
      input.addEventListener("pointercancel", () => (this.#dragging = false));
      input.addEventListener("change", (ev) => {
        this.#dragging = false;
        const value = Number(ev.currentTarget.value);
        client.send({ command: "setVolume", section: ev.currentTarget.dataset.section, value }).catch(notifyFailure);
      });
    }
    this.element.querySelector("select[name=library]")?.addEventListener("change", (ev) => {
      client.send({ command: "setActiveLibrary", libraryUuid: ev.currentTarget.value }).catch(notifyFailure);
    });
  }

  async _prepareContext() {
    const st = client.state ?? {};
    const cat = client.catalog;
    const libs = cat?.libraries ?? [];
    const activeUuid = st.libraryUuid || cat?.activeLibraryUuid;
    const lib = libs.find((l) => l.uuid === activeUuid) ?? libs[0];
    const playing = {
      Music: new Set((st.musicCategories ?? []).map((c) => c.uuid)),
      Ambiance: new Set((st.ambianceCategories ?? []).map((c) => c.uuid)),
    };
    const section = (name) => {
      const list = (lib?.[name.toLowerCase()] ?? []).filter((c) => isRegular(c) && usable(c));
      const sectionPlaying = name === "Music" ? !!st.musicPlaying : !!st.ambiancePlaying;
      return {
        name,
        label: game.i18n.localize(`AUDIOFORGE.Panel.${name}`),
        playing: sectionPlaying,
        volume: name === "Music" ? st.musicVolume ?? 0 : st.ambianceVolume ?? 0,
        categories: list.map((c) => ({ ...c, on: sectionPlaying && playing[name].has(c.uuid), icon: client.iconUrl(c.uuid, 96) })),
      };
    };
    const echoes = (lib?.ambiance ?? []).filter((c) => c.oneShot && usable(c)).map((c) => ({ ...c, icon: client.iconUrl(c.uuid, 96) }));
    return {
      connected: client.connected,
      downloadUrl: DOWNLOAD_URL,
      blocked: client.blockedReason === "mixed-content",
      libraries: libs.map((l) => ({ uuid: l.uuid, name: l.name, selected: l.uuid === lib?.uuid })),
      sections: SECTIONS.map(section),
      echoes,
      echoesVolume: st.echoesVolume ?? 1,
      savedStates: client.savedStates ?? [],
      hasScene: !!canvas?.scene,
    };
  }

  static #run(promise) {
    promise.catch(notifyFailure);
  }

  static #onToggleSection(event, target) {
    const { section, playing } = target.dataset;
    AudioForgePanel.#run(client.send({ command: playing === "true" ? "pause" : "play", section }));
  }

  static #onStopSection(event, target) {
    AudioForgePanel.#run(client.send({ command: "stop", section: target.dataset.section }));
  }

  static #onOpenRoom() {
    game.modules.get(MODULE_ID).api.openRoom();
  }

  static #onStopAll() {
    AudioForgePanel.#run(client.send({ command: "stop", section: "All" }));
  }

  static #onNextTrack(event, target) {
    const section = target.dataset.section;
    const st = client.state ?? {};
    // Audio Forge skips one category at a time, so skip every active one in the section.
    const isPlaying = section === "Music" ? st.musicPlaying : st.ambiancePlaying;
    if (!isPlaying) return;
    const active = section === "Music" ? st.musicCategories : st.ambianceCategories;
    for (const c of active ?? []) {
      AudioForgePanel.#run(client.send({ command: "nextTrack", section, categoryUuid: c.uuid }));
    }
  }

  static #onToggleCategory(event, target) {
    // Chips reflect "loaded", not "audible", so use explicit commands rather than toggleCategory.
    const { section, uuid, on } = target.dataset;
    const cmd = on === "true"
      ? { command: "setCategoryEnabled", section, categoryUuid: uuid, enabled: false }
      : section === "Music"
        ? { command: "play", section, categoryUuid: uuid }
        : { command: "setCategoryEnabled", section, categoryUuid: uuid, enabled: true };
    AudioForgePanel.#run(client.send(cmd));
  }

  static #onEcho(event, target) {
    AudioForgePanel.#run(client.send({ command: "playEcho", categoryUuid: target.dataset.uuid }, 12000));
  }

  static #onRestoreState(event, target) {
    AudioForgePanel.#run(client.send({ command: "restoreStateById", id: target.dataset.id }));
  }

  static #onApplyScene() {
    game.modules.get(MODULE_ID).api.applySceneAudio();
  }
}
