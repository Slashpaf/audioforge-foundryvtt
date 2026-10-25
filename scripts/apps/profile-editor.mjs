import { MODULE_ID, client } from "../settings.mjs";
import { applyProfile, normalizeProfile } from "../profile.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Keep the stored library selectable when Audio Forge is offline or the library is gone, so saving does not clear it. */
function withStoredLibrary(list, p) {
  if (p.libraryUuid && !list.some((l) => l.uuid === p.libraryUuid)) {
    list.push({ uuid: p.libraryUuid, name: p.libraryName || p.libraryUuid });
  }
  return list.map((l) => ({ ...l, selected: l.uuid === p.libraryUuid }));
}

/**
 * Edits one audio profile. `target` is either
 *   { type: "scene", id }   -> stored in the scene flag audioforge.profile
 *   { type: "setting", key } -> stored in a client setting
 */
export class ProfileEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["audioforge", "audioforge-profile"],
    position: { width: 420 },
    window: { icon: "af-icon", resizable: false },
    form: { handler: ProfileEditor.#onSubmit, closeOnSubmit: true },
    actions: { test: ProfileEditor.#onTest },
  };

  static PARTS = { form: { template: `modules/${MODULE_ID}/templates/profile-editor.hbs` } };

  constructor(target, label, options = {}) {
    super(options);
    this.target = target;
    this.label = label;
  }

  get title() {
    return game.i18n.format("AUDIOFORGE.Profile.Title", { name: this.label });
  }

  #stored() {
    if (this.target.type === "scene") {
      return game.scenes.get(this.target.id)?.getFlag(MODULE_ID, "profile");
    }
    return game.settings.get(MODULE_ID, this.target.key);
  }

  /** Re-render when the catalog or saved states arrive after the window opened. */
  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    this._refresh = () => this.rendered && this.render();
    for (const ev of ["catalog", "savedStates", "connection"]) client.addEventListener(ev, this._refresh);
  }

  _onClose(options) {
    for (const ev of ["catalog", "savedStates", "connection"]) client.removeEventListener(ev, this._refresh);
    super._onClose?.(options);
  }

  /** Unsaved working copy, so pushes from Audio Forge never reset the form. */
  #draft = null;

  #bound = false;

  _onRender(context, options) {
    super._onRender?.(context, options);
    // The form element survives re-renders, so bind once.
    if (this.#bound) return;
    this.#bound = true;
    this.element.addEventListener("change", (ev) => {
      this.#draft = ProfileEditor.#read(this.element);
      // The category lists depend on the chosen library.
      if (ev.target.name === "libraryUuid") this.render();
    });
  }

  async _prepareContext() {
    const p = this.#draft ?? normalizeProfile(this.#stored());
    const catalog = client.catalog;
    const libs = catalog?.libraries ?? [];
    // Categories come from the chosen library, else the active one.
    const lib = libs.find((l) => l.uuid === (p.libraryUuid || catalog?.activeLibraryUuid)) ?? libs[0];
    // Keep a stored choice visible even when Audio Forge is offline or the item vanished.
    const withStored = (list, stored) => {
      const out = (list ?? []).map((c) => ({ uuid: c.uuid, name: c.name }));
      for (const s of stored) if (s && !out.some((c) => c.uuid === s.uuid)) out.push({ uuid: s.uuid, name: s.name || s.uuid });
      return out;
    };
    const states = (client.savedStates ?? []).map((s) => ({ id: s.id, name: s.name }));
    if (p.stateId && !states.some((s) => s.id === p.stateId)) states.push({ id: p.stateId, name: p.stateName || p.stateId });
    const ambianceSel = new Set(p.ambiance.map((c) => c.uuid));
    return {
      p,
      offline: !client.connected,
      modes: ["none", "state", "categories"].map((m) => ({
        value: m,
        label: game.i18n.localize(`AUDIOFORGE.Profile.Mode${m[0].toUpperCase()}${m.slice(1)}`),
        selected: p.mode === m,
      })),
      states: states.map((s) => ({ ...s, selected: s.id === p.stateId })),
      libraries: withStoredLibrary(libs.map((l) => ({ uuid: l.uuid, name: l.name })), p),
      music: withStored(lib?.music?.filter((c) => !c.oneShot), [p.music]).map((c) => ({ ...c, selected: c.uuid === p.music?.uuid })),
      ambiance: withStored(lib?.ambiance?.filter((c) => !c.oneShot), p.ambiance).map((c) => ({ ...c, selected: ambianceSel.has(c.uuid) })),
    };
  }

  /** Read the form into a profile, resolving names from what the form currently lists. */
  static #read(form) {
    const fd = new foundry.applications.ux.FormDataExtended(form).object;
    const labelOf = (select, value) => [...select.options].find((o) => o.value === value)?.text ?? "";
    const el = (name) => form.elements[name];
    const ambianceIds = [].concat(fd.ambiance ?? []).filter(Boolean);
    const libSel = el("libraryUuid");
    return normalizeProfile({
      mode: fd.mode,
      stateId: fd.stateId || "",
      stateName: fd.stateId ? labelOf(el("stateId"), fd.stateId) : "",
      libraryUuid: fd.libraryUuid || "",
      libraryName: fd.libraryUuid ? labelOf(libSel, fd.libraryUuid) : "",
      music: fd.music ? { uuid: fd.music, name: labelOf(el("music"), fd.music) } : null,
      ambiance: ambianceIds.map((uuid) => ({ uuid, name: labelOf(el("ambiance"), uuid) })),
      stopMusic: !!fd.stopMusic,
      stopAmbiance: !!fd.stopAmbiance,
      stopEchoes: !!fd.stopEchoes,
    });
  }

  static async #onSubmit(event, form) {
    const profile = ProfileEditor.#read(form);
    if (this.target.type === "scene") {
      await game.scenes.get(this.target.id)?.setFlag(MODULE_ID, "profile", profile);
    } else {
      await game.settings.set(MODULE_ID, this.target.key, profile);
    }
    ui.notifications.info("AUDIOFORGE.Profile.Saved", { localize: true });
  }

  static async #onTest() {
    try {
      await applyProfile(client, ProfileEditor.#read(this.element));
    } catch (err) {
      ui.notifications.warn(game.i18n.format("AUDIOFORGE.Notify.Failed", { error: err.message }));
    }
  }
}

export class CombatStartProfile extends ProfileEditor {
  constructor(options) {
    super({ type: "setting", key: "combatStart" }, game.i18n.localize("AUDIOFORGE.Profile.CombatStart"), options);
  }
}

export class CombatEndProfile extends ProfileEditor {
  constructor(options) {
    super({ type: "setting", key: "combatEnd" }, game.i18n.localize("AUDIOFORGE.Profile.CombatEnd"), options);
  }
}
