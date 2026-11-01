/**
 * The `client` surface the control panel reads (state, catalog, savedStates, connected, send, "state"/"catalog" events),
 * backed by a room guest that the host allowed to control Audio Forge: data comes from the host's snapshots and commands
 * travel as control.command. Pure ES module with no Foundry dependencies so it can be tested under Node.
 */

const DEFAULT_TIMEOUT_MS = 5000;

export class RemoteControlClient extends EventTarget {
  #guest;
  #pending = new Map();

  state = null;
  catalog = null;
  savedStates = [];
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
  send({ command, requestId, ...args }, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

  /** No Audio Forge on this machine to serve icons from. */
  iconUrl() {
    return "";
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
    } else {
      this.state = snap.state ? { type: "state", ...snap.state } : null;
      this.catalog = snap.catalog ? { type: "catalog", ...snap.catalog } : null;
      this.savedStates = Array.isArray(snap.savedStates) ? snap.savedStates : [];
    }
    if (!connected) this.#rejectPending(new Error("Audio Forge connection closed"));
    if (was !== connected) this.dispatchEvent(new CustomEvent("connection", { detail: connected }));
    this.dispatchEvent(new CustomEvent("state", { detail: this.state }));
    this.dispatchEvent(new CustomEvent("catalog", { detail: this.catalog }));
    this.dispatchEvent(new CustomEvent("savedStates", { detail: this.savedStates }));
  }
}
