import { MODULE_ID } from "../settings.mjs";
import { roomSession } from "../rooms/session.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Player window: the room the GM opened, whether you are in it, and a volume control. */
export class RoomPlayerPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "audioforge-room-player",
    classes: ["audioforge", "audioforge-room"],
    position: { width: 320, height: "auto" },
    window: { title: "AUDIOFORGE.Room.PlayerTitle", icon: "af-icon", resizable: false },
    actions: {
      join: RoomPlayerPanel.#onJoin,
      leave: RoomPlayerPanel.#onLeave,
      unlock: RoomPlayerPanel.#onUnlock,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/room-player.hbs` } };

  #refresh = () => this.render();

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    roomSession.addEventListener("change", this.#refresh);
  }

  _onClose(options) {
    roomSession.removeEventListener("change", this.#refresh);
    super._onClose?.(options);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("input[name=volume]")?.addEventListener("input", (ev) => roomSession.setVolume(Number(ev.currentTarget.value)));
  }

  async _prepareContext() {
    const status = roomSession.playerStatus;
    return {
      open: !!roomSession.room,
      status,
      statusLabel: game.i18n.localize(`AUDIOFORGE.Room.Player.${status}`),
      joined: status === "joined",
      waiting: status === "waiting",
      removed: status === "removed",
      error: status === "error",
      canJoin: !!roomSession.room && ["idle", "waiting", "removed", "error", "closed"].includes(status),
      canLeave: ["joined", "connecting", "waiting"].includes(status),
      blocked: status === "joined" && roomSession.audioBlocked,
      volume: roomSession.volume,
    };
  }

  static #onJoin() {
    roomSession.join();
  }

  static #onLeave() {
    roomSession.leave();
  }

  static #onUnlock() {
    roomSession.resumeAudio();
  }
}
