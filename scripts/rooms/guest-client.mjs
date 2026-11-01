/**
 * Headless Audio Forge Rooms guest: joins a room as a listener and hands the host's PCM audio to a sink.
 * Pure ES module with no Foundry dependencies so it can be tested under Node.
 * Emits "status" (detail: { status, reason?, clientId?, username? }), "room" (detail: room state),
 * "control" (the permission or the control snapshot changed) and "result" (detail: { requestId, ok, error? } of a control command).
 *
 * status: idle | connecting | joined | waiting (room full) | removed (kicked) | error | closed (room gone)
 */

const MAX_BACKOFF_MS = 10000;

const CLOSE_CODES = { 4401: "invalid_room_password", 4403: "kicked", 4404: "room_not_found", 4409: "room_full", 4429: "guest_limit_reached" };

/** How each join refusal maps to a status. Anything not listed is treated as a lost connection and retried. */
const FATAL = {
  room_full: "waiting",
  guest_limit_reached: "waiting",
  kicked: "removed",
  invalid_room_password: "error",
  room_not_found: "closed",
};

export function roomWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

export class RoomGuestClient extends EventTarget {
  #ws = null;
  #timer = null;
  #attempt = 0;
  #wanted = false;
  #cfg = null;
  #sink = null;
  #seq = 0;

  status = "idle";
  reason = null;
  clientId = null;
  username = null;
  room = null;
  /** What the host published for guests allowed to control Audio Forge; null while listen-only or before the first one. */
  snapshot = null;

  /** @param {{ onFormat?: (f: {sampleRate:number, channels:number}) => void, onPcm?: (bytes: Uint8Array) => void, onReset?: () => void }} sink */
  constructor(sink = {}) {
    super();
    this.#sink = sink;
  }

  /** Join (or re-join) a room. `cfg`: { baseUrl, roomId, username, sessionId, password }. */
  join(cfg) {
    this.#cfg = cfg;
    this.#wanted = true;
    this.#attempt = 0;
    this.#open();
  }

  /** This guest's own permission, from the latest room state: its own entry, else the room default. */
  get permission() {
    const own = this.room?.guests?.find((g) => g.clientId === this.clientId)?.permission;
    return own ?? this.room?.permissions?.guestPermissions?.[this.clientId] ?? this.room?.permissions?.defaultGuestPermission ?? "listen";
  }

  /** Relay a command to the host. Returns the requestId its `result` event carries, or null when not connected. */
  sendControl(payload) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1 || this.status !== "joined") return null;
    const requestId = `fvtt-c${++this.#seq}`;
    ws.send(JSON.stringify({ type: "control.command", requestId, payload }));
    return requestId;
  }

  leave() {
    this.#wanted = false;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#close();
    this.clientId = null;
    this.room = null;
    this.#setSnapshot(null);
    this.#setStatus("idle");
  }

  #open() {
    this.#close();
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(roomWebSocketUrl(this.#cfg.baseUrl));
    } catch (err) {
      this.#setStatus("error", "invalid_url");
      this.#wanted = false;
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    let joined = false;

    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      const { roomId, username, sessionId, password } = this.#cfg;
      ws.send(JSON.stringify({ type: "guest.hello", roomId, username, sessionId, password }));
    });
    ws.addEventListener("message", (ev) => {
      if (this.#ws !== ws) return;
      if (typeof ev.data !== "string") {
        if (joined) this.#sink.onPcm?.(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "server.hello") joined = true;
      this.#handle(msg);
    });
    ws.addEventListener("close", (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#sink.onReset?.();
      this.#setSnapshot(null); // no control while offline; the server sends a fresh snapshot on rejoin
      if (!this.#wanted) return; // an "error" message already settled the status
      const reason = CLOSE_CODES[ev.code] ?? (typeof ev.reason === "string" ? ev.reason : "");
      if (this.#fail(FATAL[reason] ? reason : null)) return;
      this.#retry();
    });
    // "error" is always followed by "close"; retrying is handled there.
    ws.addEventListener("error", () => {});
  }

  /** Apply a fatal refusal. Returns true when the reason ends the session (no retry). */
  #fail(reason) {
    if (!reason || !FATAL[reason]) return false;
    this.#wanted = false;
    this.clientId = null;
    this.room = null;
    this.#setSnapshot(null);
    this.#setStatus(FATAL[reason], reason);
    return true;
  }

  #handle(msg) {
    switch (msg.type) {
      case "server.hello":
        this.clientId = msg.clientId;
        this.username = msg.username;
        this.room = msg.room;
        this.#attempt = 0;
        this.#setStatus("joined");
        this.dispatchEvent(new CustomEvent("room", { detail: msg.room }));
        break;
      case "room.state":
        this.room = msg.room;
        this.dispatchEvent(new CustomEvent("room", { detail: msg.room }));
        // Only the server's snapshots are trusted, but a revoke must not wait for its null one.
        if (this.permission !== "control") this.#setSnapshot(null);
        else this.dispatchEvent(new Event("control"));
        break;
      case "control.snapshot":
        this.#setSnapshot(msg.snapshot && typeof msg.snapshot === "object" ? msg.snapshot : null);
        break;
      case "control.result":
        this.dispatchEvent(new CustomEvent("result", { detail: { requestId: msg.requestId, ok: msg.ok !== false, error: msg.error } }));
        break;
      case "audio.format":
        this.#setFormat(msg.payload);
        break;
      case "audio.chunk":
        if (msg.payload?.pcm16Base64) this.#sink.onPcm?.(base64ToBytes(msg.payload.pcm16Base64));
        break;
      case "error":
        // The close that follows carries the same information; handle it here so the reason is exact.
        if (FATAL[msg.code]) this.#fail(msg.code);
        break;
    }
  }

  #setSnapshot(snapshot) {
    if (!snapshot && !this.snapshot) return;
    this.snapshot = snapshot;
    this.dispatchEvent(new Event("control"));
  }

  #setFormat(f) {
    if (!f || !(f.sampleRate > 0) || !(f.channels > 0)) return;
    this.#sink.onFormat?.({ sampleRate: f.sampleRate, channels: f.channels });
  }

  #retry() {
    if (!this.#wanted) return;
    const delay = Math.min(1000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
    this.#attempt++;
    this.#setStatus("connecting", "reconnecting");
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#wanted) this.#open();
    }, delay);
  }

  #close() {
    const ws = this.#ws;
    this.#ws = null;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // already closed
    }
    this.#sink.onReset?.();
  }

  #setStatus(status, reason) {
    this.status = status;
    this.reason = reason ?? null;
    this.dispatchEvent(new CustomEvent("status", { detail: { status, reason, clientId: this.clientId, username: this.username } }));
  }
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
