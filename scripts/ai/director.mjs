import { MODULE_ID, client } from "../settings.mjs";
import { notifyFailure } from "../util.mjs";
import { MicStreamer } from "./mic.mjs";

/** Whether Foundry's own audio/video call is switched on for this world. */
function callEnabled() {
  try {
    return (game.webrtc?.settings?.world?.mode ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The microphone picked for the call, when there is one; the browser default otherwise. */
function callMicDevice() {
  try {
    const src = game.webrtc?.settings?.client?.audioSrc;
    return typeof src === "string" && src && src !== "default" && src !== "disabled" ? src : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drives the AI Director for the GM: start and stop, where its audio comes from, and streaming this browser's
 * microphone when that is the source. Nothing here talks to the server unless `client.aiDirectorAvailable`.
 */
class AiDirectorController {
  #mic = new MicStreamer();
  #starting = false;

  /** "mic": this browser's microphone (the GM's call microphone), "device": the input chosen in Audio Forge. */
  get source() {
    const saved = game.settings.get(MODULE_ID, "aiDirectorSource");
    if (saved === "mic" || saved === "device") return saved;
    return callEnabled() ? "mic" : "device";
  }

  get running() {
    return (client.aiDirector?.state ?? "idle") !== "idle";
  }

  get micActive() {
    return this.#mic.active;
  }

  init() {
    client.addEventListener("aiDirector", () => this.#sync().catch(notifyFailure));
  }

  async toggle() {
    if (this.running || this.#starting) return this.stop();
    return this.start();
  }

  async start() {
    if (!client.aiDirectorAvailable || this.#starting) return;
    this.#starting = true;
    try {
      const useMic = this.source === "mic";
      if (useMic) {
        await this.#startMic();
        if (!this.#mic.active) return; // stopped while the permission prompt was open
      }
      try {
        await client.sendAiDirector({ command: "aiDirectorStart", inputSource: useMic ? "remote" : "device", fresh: true });
      } catch (err) {
        this.#mic.stop();
        throw err;
      }
    } finally {
      this.#starting = false;
    }
  }

  async stop() {
    this.#mic.stop(); // also cancels a start that is still waiting for the microphone
    try {
      if (client.aiDirectorAvailable) await client.sendAiDirector({ command: "aiDirectorStop" });
    } finally {
      this.#mic.stop();
    }
  }

  async setSource(source) {
    await game.settings.set(MODULE_ID, "aiDirectorSource", source);
    if (!this.running || !client.aiDirectorAvailable) return;
    this.#starting = true; // pushes arriving while the microphone opens must not stop it
    try {
      if (source === "mic") {
        await this.#startMic();
        if (!this.#mic.active) return;
        await client.sendAiDirector({ command: "aiDirectorSetInput", inputSource: "remote" });
      } else {
        await client.sendAiDirector({ command: "aiDirectorSetInput", inputSource: "device" });
        this.#mic.stop();
      }
    } finally {
      this.#starting = false;
    }
  }

  async #startMic() {
    await this.#mic.start({ deviceId: callMicDevice(), onAudio: (buf) => client.sendAudio(buf) });
  }

  /** The app stopped or left the remote microphone (also when changed in the app itself): stop streaming. */
  async #sync() {
    const st = client.aiDirector;
    const wantMic = client.aiDirectorAvailable && !!st && st.state !== "idle" && st.inputSource === "remote";
    if (!wantMic && !this.#starting) this.#mic.stop();
  }
}

export const aiDirector = new AiDirectorController();
