import { MODULE_ID, client } from "../settings.mjs";
import { aiDirector } from "../ai/director.mjs";
import { DOWNLOAD_URL, isRegular, notifyFailure } from "../util.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PANEL_EVENTS = ["connection", "blocked", "state", "catalog", "savedStates", "aiDirector", "aiDirectorLog"];

const SECTIONS = ["Music", "Ambiance"];

/** Mirrors the app's own lists: categories with no tracks are hidden. */
const usable = (c) => c.trackCount !== 0;

/** GM control panel mirroring Audio Forge's live state. */
export class AudioForgePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "audioforge-panel",
    classes: ["audioforge", "audioforge-panel"],
    position: { width: 520, height: "auto" },
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
      toggleAi: AudioForgePanel.#onToggleAi,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/panel.hbs` } };

  #src;
  #refresh = () => this.#scheduleRender();
  #renderTimer = null;
  #dragging = false;
  #aiLogOpen = false;

  #scheduleRender() {
    if (!this.rendered) return;
    clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => {
      // Do not rebuild the DOM under a slider the user is dragging; retry after release.
      if (this.#dragging) return this.#scheduleRender();
      this.render();
    }, 80);
  }

  /** `source`: where state comes from and commands go: the local client (GM) or a RemoteControlClient (granted player). */
  constructor(source = client, options = {}) {
    super(options);
    this.#src = source;
  }

  get #remote() {
    return this.#src !== client;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    for (const ev of PANEL_EVENTS) this.#src.addEventListener(ev, this.#refresh);
  }

  _onClose(options) {
    clearTimeout(this.#renderTimer);
    for (const ev of PANEL_EVENTS) this.#src.removeEventListener(ev, this.#refresh);
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
        this.#src.send({ command: "setVolume", section: ev.currentTarget.dataset.section, value }).catch(notifyFailure);
      });
    }
    this.element.querySelector("select[name=aiSource]")?.addEventListener("change", (ev) => {
      aiDirector.setSource(ev.currentTarget.value).catch(notifyFailure);
    });
    // The panel is rebuilt on every push: keep the log open (and at the newest entry) across rebuilds.
    const details = this.element.querySelector(".af-ai-details");
    if (details) {
      details.open = this.#aiLogOpen;
      details.addEventListener("toggle", () => (this.#aiLogOpen = details.open));
      const log = details.querySelector(".af-ai-log");
      log.scrollTop = log.scrollHeight;
    }
    this.element.querySelector("select[name=library]")?.addEventListener("change", (ev) => {
      this.#src.send({ command: "setActiveLibrary", libraryUuid: ev.currentTarget.value }).catch(notifyFailure);
    });
  }

  async _prepareContext() {
    const st = this.#src.state ?? {};
    const cat = this.#src.catalog;
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
        categories: list.map((c) => ({ ...c, on: sectionPlaying && playing[name].has(c.uuid), icon: this.#src.iconUrl(c.uuid, 96) })),
      };
    };
    const echoes = (lib?.ambiance ?? []).filter((c) => c.oneShot && usable(c)).map((c) => ({ ...c, icon: this.#src.iconUrl(c.uuid, 96) }));
    return {
      connected: this.#src.connected,
      downloadUrl: DOWNLOAD_URL,
      blocked: this.#src.blockedReason === "mixed-content",
      libraries: libs.map((l) => ({ uuid: l.uuid, name: l.name, selected: l.uuid === lib?.uuid })),
      sections: SECTIONS.map(section),
      echoes,
      echoesVolume: st.echoesVolume ?? 1,
      savedStates: this.#src.savedStates ?? [],
      hasScene: !this.#remote && !!canvas?.scene,
      gm: !this.#remote,
      ai: this.#remote ? null : this.#aiContext(),
    };
  }

  /** The AI Director block, or null so the panel shows nothing when the app does not offer it. */
  #aiContext() {
    if (!client.aiDirectorAvailable) return null;
    const st = client.aiDirector;
    const running = st.state !== "idle";
    const ready = st.entitled && st.modelsReady;
    const L = (key) => game.i18n.localize(`AUDIOFORGE.Ai.${key}`);
    const kinds = { transcript: "fa-ear-listen", action: "fa-wand-magic-sparkles", error: "fa-triangle-exclamation", info: "fa-circle-info" };
    return {
      running,
      ready,
      state: L(`State.${st.state}`),
      hint: !st.entitled ? L("NotUnlocked") : !st.modelsReady ? L("NoModels") : "",
      error: st.error,
      sourceMic: aiDirector.source === "mic",
      micActive: aiDirector.micActive,
      scene: st.sceneDescription,
      log: client.aiDirectorLog.map((e) => ({
        time: new Date(e.at).toLocaleTimeString(),
        kind: e.kind,
        icon: kinds[e.kind] ?? kinds.info,
        text: e.text,
      })),
    };
  }

  static #onToggleAi() {
    AudioForgePanel.#run(aiDirector.toggle());
  }

  static #run(promise) {
    promise.catch(notifyFailure);
  }

  static #onToggleSection(event, target) {
    const { section, playing } = target.dataset;
    AudioForgePanel.#run(this.#src.send({ command: playing === "true" ? "pause" : "play", section }));
  }

  static #onStopSection(event, target) {
    AudioForgePanel.#run(this.#src.send({ command: "stop", section: target.dataset.section }));
  }

  static #onOpenRoom() {
    game.modules.get(MODULE_ID).api.openRoom();
  }

  static #onStopAll() {
    AudioForgePanel.#run(this.#src.send({ command: "stop", section: "All" }));
  }

  static #onNextTrack(event, target) {
    const section = target.dataset.section;
    const st = this.#src.state ?? {};
    // Audio Forge skips one category at a time, so skip every active one in the section.
    const isPlaying = section === "Music" ? st.musicPlaying : st.ambiancePlaying;
    if (!isPlaying) return;
    const active = section === "Music" ? st.musicCategories : st.ambianceCategories;
    for (const c of active ?? []) {
      AudioForgePanel.#run(this.#src.send({ command: "nextTrack", section, categoryUuid: c.uuid }));
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
    AudioForgePanel.#run(this.#src.send(cmd));
  }

  static #onEcho(event, target) {
    AudioForgePanel.#run(this.#src.send({ command: "playEcho", categoryUuid: target.dataset.uuid }, 12000));
  }

  static #onRestoreState(event, target) {
    AudioForgePanel.#run(this.#src.send({ command: "restoreStateById", id: target.dataset.id }));
  }

  static #onApplyScene() {
    game.modules.get(MODULE_ID).api.applySceneAudio();
  }
}
