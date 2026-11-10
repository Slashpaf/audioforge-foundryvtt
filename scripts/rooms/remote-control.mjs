/**
 * The `client` surface the control panel reads (state, catalog, savedStates, connected, send, "state"/"catalog" events),
 * backed by a room guest that the host allowed to control Audio Forge: data comes from the host's snapshots and commands
 * travel as control.command. Pure ES module with no Foundry dependencies so it can be tested under Node.
 */

import { EchoTracker } from "../echo-fill.mjs";
import { VolumePacer } from "../volume-pacer.mjs";

const DEFAULT_TIMEOUT_MS = 5000;

export class RemoteControlClient extends EventTarget {
  #guest;
  #pending = new Map();
  #pacer = new VolumePacer();

  state = null;
  catalog = null;
  savedStates = [];
  echoes = [];
  /** What the host says this guest may use (`snapshot.access`); null = everything, as before roles existed. */
  access = null;
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
    const p = this.#guest.permission;
    return (p === "control" || p === "roles") && !!this.#guest.snapshot;
  }

  /** Same shape as the local client: `{ command, ...fields }`; resolves with the host's result, rejects on error or timeout. */
  send(cmd, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return cmd.command === "setVolume" ? this.#pacer.send(cmd, (c) => this.#sendNow(c, timeoutMs)) : this.#sendNow(cmd, timeoutMs);
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
    this.#pacer.rejectAll(error);
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
      this.access = null;
      this.echoTracker.clear();
    } else {
      this.state = snap.state ? { type: "state", ...snap.state } : null;
      this.catalog = snap.catalog ? { type: "catalog", ...snap.catalog } : null;
      this.access = snap.access && typeof snap.access === "object" ? snap.access : null;
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
