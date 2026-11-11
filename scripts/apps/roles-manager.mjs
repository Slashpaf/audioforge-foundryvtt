import { MODULE_ID, client } from "../settings.mjs";
import { notifyFailure } from "../util.mjs";
import { LAYERS, editorToRole, emptyEditor, groupCatalog, roleSummary, roleToEditor, unknownSelection, validateEditor } from "../roles-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const REFRESH_EVENTS = ["connection", "catalog"];

/** GM window: create, edit and delete the roles that can be given to room guests. Roles live in Audio Forge. */
export class RolesManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "audioforge-roles",
    classes: ["audioforge", "audioforge-roles"],
    position: { width: 520, height: "auto" },
    window: { title: "AUDIOFORGE.Roles.ManagerTitle", icon: "af-icon", resizable: true },
    actions: {
      newRole: RolesManager.#onNew,
      editRole: RolesManager.#onEdit,
      deleteRole: RolesManager.#onDelete,
      saveRole: RolesManager.#onSave,
      cancelEdit: RolesManager.#onCancel,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/roles-manager.hbs` } };

  #roles = null; // null until loaded
  #loadError = false;
  #editing = null; // editor state while the editor is open
  // Never rebuild the form under an open editor: catalog pushes would wipe the search and unsaved choices.
  #refresh = () => {
    if (!this.#editing) this.render();
  };

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    for (const ev of REFRESH_EVENTS) client.addEventListener(ev, this.#refresh);
    this.#load();
  }

  _onClose(options) {
    for (const ev of REFRESH_EVENTS) client.removeEventListener(ev, this.#refresh);
    super._onClose?.(options);
  }

  async #load() {
    try {
      this.#roles = await client.listRoomRoles();
      this.#loadError = false;
    } catch {
      this.#loadError = true;
    }
    this.render();
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    root.querySelector("input[name=search]")?.addEventListener("input", () => this.#applySearch());
    for (const box of root.querySelectorAll("input[type=checkbox][data-category]")) box.addEventListener("change", () => this.#updateCounts());
    this.#updateCounts();
  }

  /** Hide categories (and the groups left empty) that do not match the search box, without rebuilding the form. */
  #applySearch() {
    const q = (this.element.querySelector("input[name=search]")?.value ?? "").trim().toLowerCase();
    for (const lib of this.element.querySelectorAll(".af-role-lib")) {
      const libMatches = !!q && (lib.dataset.name ?? "").includes(q);
      let libVisible = false;
      for (const layer of lib.querySelectorAll(".af-role-layer")) {
        let visible = false;
        for (const item of layer.querySelectorAll(".af-role-cat")) {
          const show = !q || libMatches || (item.dataset.name ?? "").includes(q);
          item.hidden = !show;
          visible ||= show;
        }
        layer.hidden = !visible;
        libVisible ||= visible;
      }
      lib.hidden = !libVisible;
    }
  }

  #updateCounts() {
    const root = this.element;
    for (const lib of root.querySelectorAll(".af-role-lib")) {
      let total = 0;
      for (const layer of lib.querySelectorAll(".af-role-layer")) {
        const n = layer.querySelectorAll("input[data-category]:checked").length;
        total += n;
        const out = layer.querySelector("[data-count]");
        if (out) out.textContent = game.i18n.format("AUDIOFORGE.Roles.Selected", { n });
      }
      const out = lib.querySelector("[data-lib-count]");
      if (out) out.textContent = game.i18n.format("AUDIOFORGE.Roles.Selected", { n: total });
    }
  }

  async _prepareContext() {
    const L = (key, data) => game.i18n.format(`AUDIOFORGE.Roles.${key}`, data);
    const base = { connected: client.connected, editing: !!this.#editing, loadError: this.#loadError, layerNames: {} };
    for (const layer of LAYERS) base.layerNames[layer] = game.i18n.localize(`AUDIOFORGE.Panel.${layer}`);
    if (!this.#editing) {
      return {
        ...base,
        loaded: this.#roles !== null,
        roles: (this.#roles ?? []).map((r) => {
          const s = roleSummary(r);
          const parts = [...s.layers.map((l) => base.layerNames[l])];
          if (s.libraries) parts.push(L("Summary.Libraries", { n: s.libraries }));
          if (s.categories) parts.push(L("Summary.Categories", { n: s.categories }));
          return { id: r.id, name: r.name, summary: parts.length ? parts.join(", ") : L("Summary.Empty") };
        }),
      };
    }
    const ed = this.#editing;
    const catalog = client.catalog;
    return {
      ...base,
      isNew: !ed.id,
      name: ed.name,
      layers: LAYERS.map((layer) => ({ layer, label: base.layerNames[layer], checked: ed.fullLayers.includes(layer) })),
      libraries: (catalog?.libraries ?? []).map((l) => ({ uuid: l.uuid, name: l.name, checked: ed.libraryUuids.includes(l.uuid) })),
      groups: groupCatalog(catalog, { selected: new Set(ed.categoryUuids) }).map((lib) => ({
        ...lib,
        search: String(lib.name ?? "").toLowerCase(),
        layers: lib.layers.map((l) => ({ ...l, label: base.layerNames[l.layer], categories: l.categories.map((c) => ({ ...c, search: c.name.toLowerCase() })) })),
      })),
    };
  }

  static #onNew() {
    this.#editing = emptyEditor();
    this.render();
  }

  static #onEdit(event, target) {
    const role = (this.#roles ?? []).find((r) => r.id === target.dataset.id);
    if (!role) return;
    this.#editing = roleToEditor(role);
    this.render();
  }

  static #onCancel() {
    this.#editing = null;
    this.render();
  }

  static async #onDelete(event, target) {
    const role = (this.#roles ?? []).find((r) => r.id === target.dataset.id);
    if (!role) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "AUDIOFORGE.Roles.Delete" },
      content: `<p>${foundry.utils.escapeHTML(game.i18n.format("AUDIOFORGE.Roles.DeleteConfirm", { name: role.name }))}</p>`,
      yes: { label: game.i18n.localize("AUDIOFORGE.Roles.Delete") },
      no: { label: game.i18n.localize("AUDIOFORGE.Roles.Cancel") },
    });
    if (!ok) return;
    try {
      await client.deleteRoomRole(role.id);
    } catch (err) {
      notifyFailure(err);
    }
    await this.#load();
  }

  static async #onSave() {
    const root = this.element;
    const checked = (selector, attr) => [...root.querySelectorAll(selector)].filter((b) => b.checked).map((b) => b.dataset[attr]);
    const original = this.#editing;
    const catalog = client.catalog;
    const editor = {
      id: original.id,
      name: root.querySelector("input[name=name]")?.value ?? "",
      fullLayers: checked("input[data-layer]", "layer"),
      libraryUuids: [...checked("input[data-library]", "library"), ...unknownSelection(catalog, original.libraryUuids, "library")],
      categoryUuids: [...checked("input[data-category]", "category"), ...unknownSelection(catalog, original.categoryUuids, "category")],
    };
    const errors = validateEditor(editor);
    if (errors.length) {
      ui.notifications.warn(`AUDIOFORGE.Roles.Errors.${errors[0]}`, { localize: true });
      return;
    }
    try {
      await client.saveRoomRole(editorToRole(editor));
    } catch (err) {
      notifyFailure(err);
      return;
    }
    this.#editing = null;
    ui.notifications.info("AUDIOFORGE.Roles.Saved", { localize: true });
    await this.#load();
  }
}
