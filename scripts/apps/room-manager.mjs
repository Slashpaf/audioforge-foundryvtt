import { MODULE_ID, client } from "../settings.mjs";
import { notifyFailure } from "../util.mjs";
import { roomSession } from "../rooms/session.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM window: open or close the online room, see who is in, remove strangers, invite players. */
export class RoomManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "audioforge-room-manager",
    classes: ["audioforge", "audioforge-room"],
    position: { width: 420, height: "auto" },
    window: { title: "AUDIOFORGE.Room.ManagerTitle", icon: "af-icon", resizable: false },
    actions: {
      openRoom: RoomManager.#onOpen,
      closeRoom: RoomManager.#onClose,
      kick: RoomManager.#onKick,
      invite: RoomManager.#onInvite,
      inviteAll: RoomManager.#onInviteAll,
      copyLink: RoomManager.#onCopyLink,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/room-manager.hbs` } };

  #refresh = () => this.render();
  #password = null; // what the GM has typed so far, kept across re-renders

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    roomSession.addEventListener("change", this.#refresh);
    client.addEventListener("connection", this.#refresh);
  }

  _onClose(options) {
    roomSession.removeEventListener("change", this.#refresh);
    client.removeEventListener("connection", this.#refresh);
    super._onClose?.(options);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("input[name=password]")?.addEventListener("input", (ev) => (this.#password = ev.currentTarget.value));
  }

  async _prepareContext() {
    const room = roomSession.room;
    const rows = roomSession.rows().map((r) => ({
      ...r,
      label: game.i18n.localize(`AUDIOFORGE.Room.State.${r.state}`),
      canKick: r.state === "joined",
      canInvite: ["idle", "waiting", "removed", "error"].includes(r.state),
    }));
    return {
      connected: client.connected,
      opening: roomSession.opening,
      room,
      password: this.#password ?? game.settings.get(MODULE_ID, "roomPassword"),
      link: room ? `${room.baseUrl}/r/${room.roomId}${room.password ? `?p=${encodeURIComponent(room.password)}` : ""}` : "",
      used: roomSession.guests.length,
      max: room?.maxGuests ?? 0,
      free: room?.tier !== "subscriber",
      full: !!room && room.maxGuests > 0 && roomSession.guests.length >= room.maxGuests,
      rows,
      waiting: rows.some((r) => r.state === "waiting"),
      strangers: roomSession.strangers(),
    };
  }

  static async #onOpen() {
    const password = this.element.querySelector("input[name=password]")?.value ?? "";
    try {
      await roomSession.open(password);
    } catch (err) {
      notifyFailure(err);
    }
  }

  static async #onClose() {
    try {
      await roomSession.close({ byHand: true });
    } catch (err) {
      notifyFailure(err);
    }
  }

  static #onKick(event, target) {
    roomSession.kick(target.dataset.clientId).catch(notifyFailure);
  }

  static #onInvite(event, target) {
    roomSession.invite(target.dataset.userId);
  }

  static #onInviteAll() {
    roomSession.inviteAll();
  }

  static async #onCopyLink(event, target) {
    try {
      await game.clipboard.copyPlainText(target.dataset.link);
      ui.notifications.info("AUDIOFORGE.Room.LinkCopied", { localize: true });
    } catch (err) {
      notifyFailure(err); // no clipboard when Foundry is served over plain HTTP
    }
  }
}
