/**
 * The `client` surface the control panel reads (state, catalog, savedStates, connected, send, "state"/"catalog" events),
 * backed by a room guest that the host allowed to control Audio Forge: data comes from the host's snapshots and commands
 * travel as control.command. Pure ES module with no Foundry dependencies so it can be tested under Node.
 */

import { EchoTracker } from "../echo-fill.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
/** The rooms server allows about 30 commands a second per guest; a slider can fire far more, so volumes are paced. */
const VOLUME_PACE_MS = 150;

export class RemoteControlClient extends EventTarget {
  #guest;
  #pending = new Map();
  #volumeSlots = new Map(); // section -> { sentAt, timer, command, waiters }

  state = null;
  catalog = null;
  savedStates = [];
  echoes = [];
  echoTracker = new EchoTracker();
  connected = false;
  apiVersion = 0;
  blockedReason = null;
  /** Nothing of the AI Director is relayed to guests. */
  aiDirectorAvailable = false;
  aiDirectorLog = [];

  /** @param {import("./guest-client.mjs").RoomGuestClient} guest */
  constructor(guest) {
    super();
    this.#guest = guest;
    guest.addEventListener("control", () => this.#sync());
    guest.addEventListener("room", () => this.#sync());
    guest.addEventListener("status", () => this.#sync());
    guest.addEventListener("result", (ev) => this.#onResult(ev.detail));
  }

  /** Whether the panel has something to show: allowed to control, and the host's snapshot has arrived. */
  get available() {
    return this.#guest.permission === "control" && !!this.#guest.snapshot;
  }

  /** Same shape as the local client: `{ command, ...fields }`; resolves with the host's result, rejects on error or timeout. */
  send(cmd, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return cmd.command === "setVolume" ? this.#sendVolume(cmd, timeoutMs) : this.#sendNow(cmd, timeoutMs);
  }

  /**
   * Volume changes of one section are sent at most every VOLUME_PACE_MS, the newest value wins. A call that was replaced
   * by a newer one resolves right away (its value no longer matters), so a drag never reports a failure per event.
   */
  #sendVolume(cmd, timeoutMs) {
    const slot = this.#volumeSlots.get(cmd.section) ?? { sentAt: 0, timer: null, command: null, waiters: [] };
    this.#volumeSlots.set(cmd.section, slot);
    return new Promise((resolve, reject) => {
      for (const w of slot.waiters) w.resolve({ type: "result", ok: true, superseded: true });
      slot.waiters = [{ resolve, reject }];
      slot.command = cmd;
      if (slot.timer) return;
      const flush = () => {
        slot.timer = null;
        slot.sentAt = Date.now();
        const { command, waiters } = slot;
        slot.waiters = [];
        this.#sendNow(command, timeoutMs).then(
          (r) => waiters.forEach((w) => w.resolve(r)),
          (e) => waiters.forEach((w) => w.reject(e)),
        );
      };
      const wait = slot.sentAt + VOLUME_PACE_MS - Date.now();
      if (wait <= 0) flush();
      else slot.timer = setTimeout(flush, wait);
    });
  }

  #sendNow({ command, requestId, ...args }, timeoutMs) {
    const id = this.connected ? this.#guest.sendControl({ command, args }) : null;
    if (!id) return Promise.reject(new Error("Audio Forge is not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Audio Forge did not answer "${command}" in time`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  /** Guests cannot reach Audio Forge, so the host uploads icons to the rooms server (a 404 just before they arrive is normal). */
  iconUrl(uuid) {
    const ref = this.#guest.roomRef;
    if (!ref) return "";
    return `${new URL(ref.baseUrl).origin}/api/rooms/${encodeURIComponent(ref.roomId)}/control-icons/${encodeURIComponent(uuid)}`;
  }

  #onResult({ requestId, ok, error }) {
    const p = this.#pending.get(requestId);
    if (!p) return;
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    if (ok) p.resolve({ type: "result", ok: true, requestId });
    else p.reject(new Error(error || "Audio Forge command failed"));
  }

  #rejectPending(error) {
    for (const slot of this.#volumeSlots.values()) {
      clearTimeout(slot.timer);
      slot.timer = null;
      for (const w of slot.waiters) w.reject(error);
      slot.waiters = [];
    }
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }

  #sync() {
    const snap = this.available ? this.#guest.snapshot : null;
    const connected = !!snap && this.#guest.status === "joined" && this.#guest.room?.hostConnected === true;
    const was = this.connected;
    this.connected = connected;
    if (!snap) {
      this.state = null;
      this.catalog = null;
      this.savedStates = [];
      this.echoes = [];
      this.echoTracker.clear();
    } else {
      this.state = snap.state ? { type: "state", ...snap.state } : null;
      this.catalog = snap.catalog ? { type: "catalog", ...snap.catalog } : null;
      this.savedStates = Array.isArray(snap.savedStates) ? snap.savedStates : [];
      this.echoes = Array.isArray(snap.echoes?.echoes) ? snap.echoes.echoes : [];
      this.echoTracker.update(this.echoes); // known playbackIds keep their start across snapshots
    }
    if (!connected) this.#rejectPending(new Error("Audio Forge connection closed"));
    if (was !== connected) this.dispatchEvent(new CustomEvent("connection", { detail: connected }));
    this.dispatchEvent(new CustomEvent("state", { detail: this.state }));
    this.dispatchEvent(new CustomEvent("catalog", { detail: this.catalog }));
    this.dispatchEvent(new CustomEvent("savedStates", { detail: this.savedStates }));
    this.dispatchEvent(new CustomEvent("echoes", { detail: this.echoes }));
  }
}
