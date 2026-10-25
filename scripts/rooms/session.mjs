import { MODULE_ID, client } from "../settings.mjs";
import { notifyFailure } from "../util.mjs";
import { RoomGuestClient } from "./guest-client.mjs";
import { PcmPlayer } from "./pcm-player.mjs";
import { buildPlayerRows, findStrangers, takeNewRejections } from "./roster.mjs";

const CHANNEL = `module.${MODULE_ID}`;

/**
 * Online room, seen from both sides.
 *  GM:     opens/closes the room through Audio Forge's Local API, tells the players, manages who is in.
 *  Player: receives the room over the Foundry socket, joins as a headless listener, reports back to the GM.
 * Emits "change" whenever anything the apps show has changed.
 */
class RoomSession extends EventTarget {
  /** { roomId, baseUrl, password, tier, maxGuests } while a room is open, else null. Known to everyone. */
  room = null;

  // GM side
  reports = new Map(); // userId -> { state, clientId } as reported by each player's own client
  guests = []; // from Audio Forge: who the rooms server says is connected
  rejections = [];
  opening = false;
  #seenRejections = null; // null until the first state arrives, so a reload does not replay old refusals
  #autoOpened = false; // the room is opened by default once per page load; closing it by hand sticks
  #polling = false;
  #pollAgain = false;

  // Player side
  #player = new PcmPlayer();
  #guest = new RoomGuestClient({
    onFormat: (f) => this.#player.setFormat(f),
    onPcm: (bytes) => this.#player.push(bytes),
    onReset: () => this.#player.reset(),
  });
  get #optedOutOf() {
    return game.settings.get(MODULE_ID, "roomOptOut") || null;
  }

  set #optedOutOf(roomId) {
    game.settings.set(MODULE_ID, "roomOptOut", roomId ?? "");
  }

  get isGM() {
    return game.user.isGM;
  }

  get playerStatus() {
    return this.#guest.status;
  }

  get playerReason() {
    return this.#guest.reason;
  }

  get audioBlocked() {
    return this.#player.blocked;
  }

  get volume() {
    return game.settings.get(MODULE_ID, "roomVolume");
  }

  init() {
    game.socket.on(CHANNEL, (data, senderId) => this.#onSocket(data, senderId));
    this.#player.setVolume(this.volume);

    this.#guest.addEventListener("status", (ev) => this.#onGuestStatus(ev.detail));
    this.#guest.addEventListener("room", () => this.#changed());

    // Browsers keep audio suspended until the page has been interacted with.
    const unlock = () => this.resumeAudio();
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });

    if (this.isGM) {
      // Only live data counts: a dropped connection must not look like "room closed" and kick everyone out,
      // and stale state must not be announced before the fresh state arrives.
      client.addEventListener("state", () => this.#onState());
      client.addEventListener("connection", (ev) => {
        if (ev.detail) this.#autoOpen();
        this.#changed();
      });
      if (client.connected) this.#autoOpen();
    } else {
      this.#send({ action: "hello" });
    }
  }

  // ---- GM actions ---------------------------------------------------------------------------------------------

  async open(password = "") {
    this.opening = true;
    this.#changed();
    try {
      const result = await client.send({
        command: "startAudioCapture",
        url: game.settings.get(MODULE_ID, "roomsServerUrl"),
        password: password.trim() || undefined,
      }, 20000);
      await game.settings.set(MODULE_ID, "roomPassword", password.trim());
      // The result carries the status; the pushed state follows. Apply it now instead of waiting.
      this.#apply(result.status);
    } finally {
      this.opening = false;
      this.#changed();
    }
  }

  /** Open the room by default so players find it, unless the GM turned that off or one is already running. */
  async #autoOpen() {
    if (this.#autoOpened || this.opening || !game.settings.get(MODULE_ID, "roomAutoOpen")) return;
    this.#autoOpened = true;
    try {
      // Older Audio Forge builds do not push the room in their state, so ask instead of assuming there is none.
      const { status } = await client.send({ command: "getAudioCaptureStatus" });
      if (status?.running && status.roomId) this.#apply(status);
      else await this.open(game.settings.get(MODULE_ID, "roomPassword"));
    } catch (err) {
      notifyFailure(err);
    }
  }

  async close() {
    await client.send({ command: "stopAudioCapture" });
    this.#apply(null);
  }

  kick(clientId) {
    return client.send({ command: "kickRoomGuest", clientId });
  }

  /** Ask a player to (re)join, e.g. after the GM freed a slot for them. */
  invite(userId) {
    this.#send({ action: "invite", userId });
  }

  inviteAll() {
    for (const row of this.rows().filter((r) => ["idle", "waiting", "removed", "error"].includes(r.state))) this.invite(row.id);
  }

  rows() {
    const users = game.users.filter((u) => !u.isGM).map((u) => ({ id: u.id, name: u.name, active: u.active }));
    return buildPlayerRows(users, this.reports, this.guests);
  }

  strangers() {
    return findStrangers(this.reports, this.guests);
  }

  // ---- Player actions -----------------------------------------------------------------------------------------

  join() {
    if (!this.room) return;
    this.#optedOutOf = null;
    this.#player.start();
    this.#guest.join({
      baseUrl: this.room.baseUrl,
      roomId: this.room.roomId,
      username: game.user.name,
      sessionId: `fvtt-${game.world.id}-${game.user.id}`,
      password: this.room.password,
    });
    this.resumeAudio();
  }

  leave() {
    this.#optedOutOf = this.room?.roomId ?? null; // leaving on purpose must not be undone by auto-join
    this.#guest.leave();
    this.#player.stop();
  }

  setVolume(value) {
    this.#player.setVolume(value);
    game.settings.set(MODULE_ID, "roomVolume", value);
  }

  async resumeAudio() {
    if (!this.#player.blocked) return;
    await this.#player.resume();
    this.#changed();
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  #changed() {
    this.dispatchEvent(new Event("change"));
  }

  #send(data) {
    game.socket.emit(CHANNEL, data);
  }

  /**
   * Current Audio Forge pushes the room (with guests and rejections) in every state. Older builds never do, so
   * a missing room is not proof that it closed: ask for the capture status, which every build answers.
   */
  #onState() {
    const room = client.state?.room;
    if (room) this.#apply(room);
    else if (this.room) this.#pollStatus();
  }

  async #pollStatus() {
    if (this.#polling) {
      this.#pollAgain = true;
      return;
    }
    this.#polling = true;
    try {
      const { status } = await client.send({ command: "getAudioCaptureStatus" });
      this.#apply(status ?? null);
    } catch {
      // Not connected or no answer: keep what we know rather than closing the room for everyone.
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // state pushes come on every track change
      this.#polling = false;
      if (this.#pollAgain) {
        this.#pollAgain = false;
        this.#onState();
      }
    }
  }

  /** `af`: Audio Forge's capture status (the `room` of a state push), or null when no room is open. */
  #apply(af) {
    const open = !!(af?.running && af.roomId && af.roomUrl);
    const next = open
      ? {
          roomId: af.roomId,
          baseUrl: new URL(af.roomUrl).origin,
          password: af.roomPassword ?? "",
          tier: af.roomAccessTier ?? "free",
          maxGuests: af.roomMaxGuests ?? 0,
        }
      : null;

    const guests = open ? af.guests ?? [] : [];
    const rejections = open ? af.rejections ?? [] : [];

    const announce = JSON.stringify(next) !== JSON.stringify(this.room);
    // State pushes arrive on every track change; only touch the UI when something it shows has changed.
    const changed = announce || JSON.stringify([guests, rejections]) !== JSON.stringify([this.guests, this.rejections]);
    this.room = next;
    this.guests = guests;
    this.rejections = rejections;
    if (!open) this.reports.clear();
    this.#notifyRejections();
    if (announce) this.#send({ action: "room", room: next });
    if (changed) this.#changed();
  }

  #notifyRejections() {
    if (this.#seenRejections === null) {
      this.#seenRejections = new Set();
      takeNewRejections(this.rejections, this.#seenRejections);
      return;
    }
    const fresh = takeNewRejections(this.rejections, this.#seenRejections);
    for (const r of fresh) {
      const key = this.room?.tier === "subscriber" ? "AUDIOFORGE.Room.RejectedGM" : "AUDIOFORGE.Room.RejectedGMFree";
      ui.notifications.warn(game.i18n.format(key, { name: r.username || "?", max: this.room?.maxGuests ?? "?" }), { permanent: true });
    }
  }

  #onSocket(data, senderId) {
    const sender = game.users.get(senderId);
    if (!sender || !data?.action) return;

    if (this.isGM) {
      // Only the GM that is connected to Audio Forge knows the room; another GM would answer "none".
      if (data.action === "hello") {
        if (client.connected) this.#send({ action: "room", room: this.room });
      }
      else if (data.action === "status" && !sender.isGM) {
        this.reports.set(senderId, { state: data.state, clientId: data.clientId ?? null });
        this.#changed();
      }
      return;
    }

    if (!sender.isGM) return; // only the GM may open rooms or invite
    if (data.action === "room") this.#onRoom(data.room);
    else if (data.action === "invite" && data.userId === game.user.id) this.join();
  }

  #onRoom(room) {
    const changed = room?.roomId !== this.room?.roomId;
    this.room = room ?? null;
    if (!room) {
      this.#guest.leave();
      this.#player.stop();
    } else if (changed && game.settings.get(MODULE_ID, "roomAutoJoin") && room.roomId !== this.#optedOutOf) {
      this.join();
    } else if (!changed) {
      this.#report(); // a GM that reloaded lost its roster; tell it where we are
    }
    this.#changed();
  }

  #report() {
    const { status, clientId } = this.#guest;
    const state = { connecting: "connecting", joined: "joined", waiting: "waiting", removed: "removed", error: "error", idle: "idle", closed: "idle" }[status];
    this.#send({ action: "status", state, clientId: status === "joined" ? clientId : null });
  }

  #onGuestStatus({ status }) {
    this.#report();
    // Nothing is playing in these states, so do not keep an audio context open.
    if (["removed", "waiting", "error", "closed"].includes(status)) this.#player.stop();
    if (status === "waiting") ui.notifications.warn("AUDIOFORGE.Room.RejectedPlayer", { localize: true });
    if (status === "removed") {
      this.#optedOutOf = this.room?.roomId ?? null; // a kick is final until the GM invites or the player rejoins
      ui.notifications.info("AUDIOFORGE.Room.Removed", { localize: true });
    }
    this.#changed();
  }
}

export const roomSession = new RoomSession();
