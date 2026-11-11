import { MODULE_ID, client } from "../settings.mjs";
import { RemoteControlClient } from "./remote-control.mjs";
import { notifyFailure, resetRoomSessionId, roomSessionId } from "../util.mjs";
import { RoomGuestClient } from "./guest-client.mjs";
import { PcmPlayer } from "./pcm-player.mjs";
import { buildPlayerRows, findStrangers, takeNewRejections } from "./roster.mjs";

const CHANNEL = `module.${MODULE_ID}`;
const RECOVERABLE_REFRESH_MS = 10_000; // how often the room window may ask the app for a resumable room
const EMPTY_ROOM_GRACE_MS = 60_000; // a player reloading the page should not close the room

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
  /** A saved room the app could resume (`client.getRecoverableRoom()`), only while no room is open; else null. */
  recoverable = null;
  roles = null; // [{ id, name }] the app offers for this room, or null when it has no roles
  defaultPermission = "listen"; // who may control Audio Forge: "listen" (only the GM) or "control" (everyone)
  rejections = [];
  opening = false;
  #seenRejections = null; // null until the first state arrives, so a reload does not replay old refusals
  #recoverableBusy = false;
  #recoverableAt = 0;
  #weOpened = false; // only a room this module opened by itself is closed by itself
  #suppressed = false; // the GM closed the room by hand: stay closed until every player has left once
  #autoBusy = false;
  #verified = false; // whether the room we show was checked against Audio Forge since it last connected
  #closeTimer = null;
  #polling = false;
  #pollAgain = false;

  // Player side
  #player = new PcmPlayer();
  #guest = new RoomGuestClient({
    onFormat: (f) => this.#player.setFormat(f),
    onPcm: (bytes) => this.#player.push(bytes),
    onReset: () => this.#player.reset(),
  });
  /** What a player allowed to control Audio Forge drives; looks like `client` to the panel. */
  remote = new RemoteControlClient(this.#guest);
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

  /** The rooms server the player's connection goes to (host:port). */
  get playerTarget() {
    return this.#guest.target;
  }

  get playerReason() {
    return this.#guest.reason;
  }

  /** The GM has allowed this player to control Audio Forge and the host's snapshot is here. */
  get canControl() {
    return this.remote.available;
  }

  /** GM side: the connected Audio Forge can hand out control. */
  get controlAvailable() {
    return client.roomControlAvailable;
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
    this.#guest.addEventListener("control", () => this.#changed());

    // Browsers keep audio suspended until the page has been interacted with.
    const unlock = () => this.resumeAudio();
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });

    if (this.isGM) {
      // Only live data counts: a dropped connection must not look like "room closed" and kick everyone out,
      // and stale state must not be announced before the fresh state arrives.
      client.addEventListener("state", () => this.#onState());
      client.addEventListener("connection", () => {
        if (!client.connected) {
          this.#verified = false; // Audio Forge was closed: whatever room it had is gone
          this.#setRecoverable(null);
        }
        this.#syncAuto();
        this.#changed();
      });
      Hooks.on("userConnected", () => this.#syncAuto());
      this.#syncAuto();
    } else {
      this.#send({ action: "hello" });
    }
  }

  // ---- GM actions ---------------------------------------------------------------------------------------------

  /** Open the room: resumes the app's saved room when there is one (and the app can), else creates a new one. `fresh`: never resume. */
  async open(password = "", { fresh = false } = {}) {
    this.#weOpened = false; // a room the GM opens is the GM's to close
    this.#suppressed = false;
    return this.#open(password, { fresh });
  }

  async #open(password, { fresh = false } = {}) {
    this.opening = true;
    this.#changed();
    try {
      const url = game.settings.get(MODULE_ID, "roomsServerUrl");
      const pass = password.trim() || undefined;
      if (!fresh && (await this.#resume(url, pass))) {
        await game.settings.set(MODULE_ID, "roomPassword", password.trim());
        return;
      }
      const result = await client.send({ command: "startAudioCapture", url, password: pass }, 20000);
      await game.settings.set(MODULE_ID, "roomPassword", password.trim());
      // The result carries the status; the pushed state follows. Apply it now instead of waiting.
      this.#apply(result.status);
    } finally {
      this.opening = false;
      this.#changed();
    }
  }

  /**
   * Try to resume the app's saved room. True when a room is now running (resumed, or already hosted by the app and
   * adopted); false when there is nothing to resume, so the caller creates a new room. Other errors are thrown.
   */
  async #resume(url, password) {
    if (!client.roomRecoveryAvailable) return false;
    const saved = await client.getRecoverableRoom();
    if (!saved) {
      this.#setRecoverable(null);
      return false;
    }
    let result;
    try {
      result = await client.send({ command: "startAudioCapture", url, password, resume: true }, 20000);
    } catch (err) {
      const text = String(err?.message ?? err);
      if (/no recoverable room|room not recoverable/i.test(text)) {
        this.#setRecoverable(null);
        return false;
      }
      if (/room already running/i.test(text)) {
        const { status } = await client.send({ command: "getAudioCaptureStatus" });
        if (status?.running && status.roomId) {
          this.#verified = true;
          this.#apply(status);
          return true;
        }
      }
      throw err;
    }
    const status = result.status ?? (await client.send({ command: "getAudioCaptureStatus" })).status;
    this.#setRecoverable(null);
    this.#apply(status);
    ui.notifications.info("AUDIOFORGE.Room.Resumed", { localize: true });
    return true;
  }

  /** Ask the app whether a saved room can be resumed (only while no room is open). Throttled, never throws. */
  async refreshRecoverable() {
    if (!this.isGM || this.room || this.opening || !client.roomRecoveryAvailable) return this.#setRecoverable(null);
    if (this.#recoverableBusy || Date.now() - this.#recoverableAt < RECOVERABLE_REFRESH_MS) return;
    this.#recoverableBusy = true;
    try {
      const saved = await client.getRecoverableRoom();
      this.#recoverableAt = Date.now();
      this.#setRecoverable(this.room ? null : saved);
    } finally {
      this.#recoverableBusy = false;
    }
  }

  #setRecoverable(saved) {
    const key = (r) => (r ? `${r.roomId}|${Math.ceil((r.hostGraceRemainingSeconds ?? 0) / 60)}` : "");
    const changed = key(saved) !== key(this.recoverable);
    this.recoverable = saved;
    if (!saved) this.#recoverableAt = 0;
    if (changed) this.#changed();
  }

  /**
   * The room follows the table: it opens when the first player is connected and closes a minute after the last one
   * leaves, so nothing is streamed to an empty room. Only a room opened here is closed here.
   */
  async #syncAuto() {
    if (this.#autoBusy || this.opening || !client.connected) return;
    this.#autoBusy = true;
    try {
      await this.#verifyRoom();
      if (game.settings.get(MODULE_ID, "roomAutoOpen")) await this.#autoManage();
    } catch (err) {
      notifyFailure(err);
    } finally {
      this.#autoBusy = false;
    }
  }

  /**
   * After Audio Forge (re)connects, ask what room it really has. A room we still show may have died with the app;
   * players are told it closed, and the automatic opening below starts a fresh one they join on their own.
   */
  async #verifyRoom() {
    if (this.#verified) return;
    // Older Audio Forge builds do not push the room in their state, so ask instead of assuming there is none.
    const { status } = await client.send({ command: "getAudioCaptureStatus" });
    this.#verified = true;
    if (status?.running && status.roomId) this.#apply(status);
    else if (this.room) this.#apply(null);
  }

  async #autoManage() {
    const players = game.users.some((u) => !u.isGM && u.active);

    if (!players) {
      this.#suppressed = false;
      // Somebody who found the link (or a player still listening) keeps the room alive. Older Audio Forge builds
      // do not report guests, so there the room closes as soon as the players are gone.
      if (this.guests.length) {
        clearTimeout(this.#closeTimer);
        this.#closeTimer = null;
      } else if (this.room && this.#weOpened && !this.#closeTimer) {
        this.#closeTimer = setTimeout(() => {
          this.#closeTimer = null;
          if (!game.users.some((u) => !u.isGM && u.active) && !this.guests.length && this.#weOpened) this.close({ recoverable: true }).catch(notifyFailure);
        }, EMPTY_ROOM_GRACE_MS);
      }
      return;
    }

    clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    if (this.room || this.#suppressed) return;

    await this.#open(game.settings.get(MODULE_ID, "roomPassword"));
    this.#weOpened = true;
  }

  /**
   * Close the room. `recoverable` (used by the automatic close, only honoured when the app supports it) keeps the room
   * alive on the rooms server for its grace period so it can be resumed; the default closes it for good.
   */
  async close({ byHand = false, recoverable = false } = {}) {
    if (byHand) this.#suppressed = true;
    this.#weOpened = false;
    const keep = recoverable && client.roomRecoveryAvailable;
    await client.send(keep ? { command: "stopAudioCapture", recoverable: true } : { command: "stopAudioCapture" });
    this.#apply(null);
    if (keep) this.refreshRecoverable().catch(() => {});
  }

  kick(clientId) {
    return client.send({ command: "kickRoomGuest", clientId });
  }

  /** Let one guest (a clientId) control Audio Forge, or take it away. */
  setGuestControl(clientId, enabled) {
    return client.send({ command: "setRoomGuestPermission", clientId, permission: enabled ? "control" : "listen" });
  }

  /**
   * Give one guest roles: switches the guest to roles mode when needed, then assigns the role ids.
   * `current`: the guest's present permission, to skip a needless switch. Needs `this.roles` (the app supports roles).
   */
  async setGuestRoles(clientId, roleIds, current) {
    if (!this.roles) throw new Error("This version of Audio Forge has no roles");
    // The app puts the guest in roles mode itself when roles are given (setRoomGuestPermission refuses "roles").
    return client.send({ command: "setRoomGuestRoles", clientId, roleIds });
  }

  /** A roles-mode guest becomes listen-only: roles are cleared, then the guest is switched to listen. */
  async dropGuestRoles(clientId) {
    return client.send({ command: "setRoomGuestRoles", clientId, roleIds: [] }); // an empty list returns the guest to listen
  }

  /** Who may control Audio Forge in this room. Not remembered: every room starts at "only me". */
  async setDefaultControl(everyone) {
    if (!this.room) return;
    await client.send({ command: "setRoomDefaultPermission", permission: everyone ? "control" : "listen" });
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
    try {
      this.#player.start();
      this.#guest.join({
        baseUrl: this.room.baseUrl,
        roomId: this.room.roomId,
        username: game.user.name,
        sessionId: roomSessionId(globalThis.localStorage, `${MODULE_ID}.session.${game.world.id}.${game.user.id}`),
        password: this.room.password,
      });
      this.resumeAudio();
    } catch (err) {
      // A click that silently does nothing is the worst failure: say what broke.
      console.error("Audio Forge: could not join the room", err);
      notifyFailure(err);
    }
  }

  /** The server restored this player's earlier access in the current session (shown quietly, never hidden). */
  get resumed() {
    return this.#guest.resumed;
  }

  /**
   * Forget who this player was in the room and rejoin as a new guest (default access): the server drops the stored
   * session when it supports it, otherwise the connection is just closed. Either way the session id is replaced.
   */
  async startAnew() {
    const roomId = this.room?.roomId;
    const forgotten = await this.#guest.forget();
    if (!forgotten) this.#guest.leave();
    this.#player.stop();
    resetRoomSessionId(globalThis.localStorage, `${MODULE_ID}.session.${game.world.id}.${game.user.id}`);
    if (this.room && this.room.roomId === roomId) this.join();
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
    const defaultPermission = open ? af.defaultGuestPermission ?? "listen" : "listen";
    const rejections = open ? af.rejections ?? [] : [];
    const roles = open && Array.isArray(af.roles) ? af.roles : null;

    const announce = JSON.stringify(next) !== JSON.stringify(this.room);
    // State pushes arrive on every track change; only touch the UI when something it shows has changed.
    const changed = announce || JSON.stringify([guests, rejections, defaultPermission, roles]) !== JSON.stringify([this.guests, this.rejections, this.defaultPermission, this.roles]);
    this.room = next;
    this.defaultPermission = defaultPermission;
    this.roles = roles;
    this.guests = guests;
    this.rejections = rejections;
    if (!open) {
      this.reports.clear();
      this.#weOpened = false;
    }
    this.#notifyRejections();
    if (announce) this.#send({ action: "room", room: next });
    if (changed) this.#changed();
    if (open && !announce && changed) this.#syncAuto(); // the last guest leaving may be what lets the room close
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
