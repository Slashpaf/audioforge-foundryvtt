/**
 * Browser WebSocket client for the Audio Forge Local API.
 * Pure ES module with no Foundry dependencies so it can be tested under Node.
 * Emits: "connection" (detail: boolean), "state", "catalog", "savedStates", "echo".
 */

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 30000;

export function isLoopback(host) {
  const h = String(host).toLowerCase();
  return ["localhost", "[::1]", "::1"].includes(h) || h.endsWith(".localhost") || /^127\./.test(h);
}

export class AudioForgeClient extends EventTarget {
  #ws = null;
  #timer = null;
  #delay = 1000;
  #wanted = false;
  #pending = new Map();
  #seq = 0;
  #cfg = { host: "localhost", port: 8329, apiKey: "" };

  state = null;
  catalog = null;
  savedStates = [];
  connected = false;
  /** Set when the browser would block the connection (https page -> ws:// to a non-loopback host). */
  blockedReason = null;

  get baseUrl() {
    return `http://${this.#cfg.host}:${this.#cfg.port}`;
  }

  configure({ host, port, apiKey }) {
    const next = { host: host || "localhost", port: Number(port) || 8329, apiKey: apiKey || "" };
    const changed = JSON.stringify(next) !== JSON.stringify(this.#cfg);
    this.#cfg = next;
    if (changed && this.#wanted) this.#open();
  }

  start() {
    this.#wanted = true;
    this.#delay = 1000;
    this.#open();
  }

  stop() {
    this.#wanted = false;
    this.#teardown();
    this.#setConnected(false);
  }

  /** Send a command and resolve with the server's result message. Rejects on error result or timeout. */
  send(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("Audio Forge is not connected"));
    const requestId = command.requestId ?? `fvtt-${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Audio Forge did not answer "${command.command}" in time`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...command, requestId }));
    });
  }

  /** Resolve with the next state push (the server debounces broadcasts by ~250 ms), or the current state on timeout. */
  nextState(timeoutMs = 1000) {
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.removeEventListener("state", onState);
        resolve(value);
      };
      const onState = (ev) => done(ev.detail);
      const timer = setTimeout(() => done(this.state), timeoutMs);
      this.addEventListener("state", onState);
    });
  }

  async fetchSavedStates() {
    try {
      const q = this.#cfg.apiKey ? `?apiKey=${encodeURIComponent(this.#cfg.apiKey)}` : "";
      const resp = await fetch(`${this.baseUrl}/api/saved_states${q}`);
      if (!resp.ok) return;
      this.#setSavedStates((await resp.json()).savedStates ?? []);
    } catch {
      // The websocket "saved_states" push is the primary path; HTTP is a best-effort refresh.
    }
  }

  /** URL for a category icon, including the API key when one is configured. */
  iconUrl(categoryUuid, size = 96) {
    const key = this.#cfg.apiKey ? `&apiKey=${encodeURIComponent(this.#cfg.apiKey)}` : "";
    return `${this.baseUrl}/api/icon/${encodeURIComponent(categoryUuid)}?size=${size}${key}`;
  }

  /** The configured API key, with the key removed from any text (for logs and UI). */
  redact(text) {
    const key = this.#cfg.apiKey;
    if (!key) return String(text);
    return String(text).split(key).join("[redacted]").split(encodeURIComponent(key)).join("[redacted]");
  }

  #open() {
    this.#teardown();
    const { host, port, apiKey } = this.#cfg;
    const insecurePage = globalThis.location?.protocol === "https:";
    if (insecurePage && !isLoopback(host)) {
      this.blockedReason = "mixed-content";
      this.#setConnected(false);
      this.dispatchEvent(new CustomEvent("blocked", { detail: this.blockedReason }));
      return;
    }
    this.blockedReason = null;
    const url = `ws://${host}:${port}/ws${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ""}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#delay = 1000;
      this.#setConnected(true);
      this.fetchSavedStates();
    });
    ws.addEventListener("message", (ev) => {
      if (this.#ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.#handle(msg);
    });
    ws.addEventListener("close", () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#setConnected(false);
      this.#scheduleReconnect();
    });
    // "error" is always followed by "close"; reconnection is handled there.
    ws.addEventListener("error", () => {});
  }

  #teardown() {
    clearTimeout(this.#timer);
    this.#timer = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.#rejectPending(new Error("Audio Forge connection closed"));
  }

  #scheduleReconnect() {
    if (!this.#wanted || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#delay = Math.min(this.#delay * 2, MAX_BACKOFF_MS);
      if (this.#wanted) this.#open();
    }, this.#delay);
  }

  #rejectPending(error) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }

  #setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    if (!value) {
      this.#rejectPending(new Error("Audio Forge connection closed"));
    }
    this.dispatchEvent(new CustomEvent("connection", { detail: value }));
  }

  #setSavedStates(list) {
    this.savedStates = list;
    this.dispatchEvent(new CustomEvent("savedStates", { detail: list }));
  }

  #handle(msg) {
    switch (msg.type) {
      case "state":
        this.state = msg;
        this.dispatchEvent(new CustomEvent("state", { detail: msg }));
        break;
      case "catalog":
        this.catalog = msg;
        this.dispatchEvent(new CustomEvent("catalog", { detail: msg }));
        break;
      case "saved_states":
        this.#setSavedStates(msg.savedStates ?? []);
        break;
      case "echo":
        this.dispatchEvent(new CustomEvent("echo", { detail: msg }));
        break;
      case "result": {
        const p = msg.requestId != null ? this.#pending.get(msg.requestId) : null;
        if (!p) break;
        this.#pending.delete(msg.requestId);
        clearTimeout(p.timer);
        if (msg.ok === false) p.reject(new Error(msg.error || "Audio Forge command failed"));
        else p.resolve(msg);
        break;
      }
    }
  }
}
