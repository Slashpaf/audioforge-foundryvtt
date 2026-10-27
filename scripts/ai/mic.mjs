import { PcmBatcher, PcmConverter } from "./pcm.mjs";

/** AudioWorklet body, loaded from a blob: hands every 128-sample block of channel 0 to the main thread. */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("audioforge-tap", Tap);
`;

/** Captures this browser's microphone and delivers 16 kHz mono PCM16 buffers to `onAudio`. */
export class MicStreamer {
  #stream = null;
  #ctx = null;
  #node = null;

  #gen = 0;
  #pending = null;

  get active() {
    return !!this.#stream;
  }

  /**
   * Opens the microphone. Concurrent calls share one attempt, and `stop()` cancels an attempt still waiting on
   * the permission prompt (the promise then resolves with `active` false). Throws a readable Error when the
   * microphone cannot be used. @param {{deviceId?: string, onAudio: (b: ArrayBuffer) => void}} opts
   */
  start(opts) {
    if (this.#stream) return Promise.resolve();
    this.#pending ??= this.#open(opts, this.#gen).finally(() => (this.#pending = null));
    return this.#pending;
  }

  async #open({ deviceId, onAudio }, gen) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("The browser does not allow microphone access on this page (it needs HTTPS or localhost)");
    }
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (deviceId) audio.deviceId = { ideal: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    let ctx = null;
    const release = () => {
      for (const t of stream.getTracks()) t.stop();
      ctx?.close().catch(() => {});
    };
    try {
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const converter = new PcmConverter(ctx.sampleRate);
      const batcher = new PcmBatcher();
      const node = new AudioWorkletNode(ctx, "audioforge-tap", { numberOfOutputs: 0 });
      node.port.onmessage = (ev) => {
        const frame = batcher.push(converter.convert(ev.data));
        if (frame) onAudio(frame);
      };
      ctx.createMediaStreamSource(stream).connect(node);
      await ctx.resume();
      if (gen !== this.#gen) return release(); // stop() was called while we were opening
      this.#stream = stream;
      this.#ctx = ctx;
      this.#node = node;
    } catch (err) {
      release();
      throw err;
    }
  }

  stop() {
    this.#gen++;
    if (this.#node?.port) this.#node.port.onmessage = null;
    this.#node?.disconnect();
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#ctx?.close().catch(() => {});
    this.#stream = this.#ctx = this.#node = null;
  }
}
