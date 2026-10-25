/**
 * Plays the interleaved PCM16 stream a room host sends. Chunks are scheduled back to back on the Web Audio
 * clock behind a jitter buffer; if the stream stalls, scheduling restarts behind a fresh buffer.
 */

const START_BUFFER_S = 1.0; // hosts send audio in uneven bursts, so start with some headroom
const MIN_LEAD_S = 0.05;
const MAX_LEAD_S = 2.5; // a host clock running fast must not build up an ever-growing delay

export class PcmPlayer {
  #ctx = null;
  #gain = null;
  #format = { sampleRate: 44100, channels: 2 };
  #nextTime = 0;
  #volume = 1;
  #leftover = null; // an odd trailing byte (or partial frame) carried into the next chunk

  /** Create the audio graph. Call from a user gesture when possible; use `resume()` otherwise. */
  start() {
    if (this.#ctx) return;
    this.#ctx = new AudioContext();
    this.#gain = this.#ctx.createGain();
    this.#gain.gain.value = this.#volume;
    this.#gain.connect(this.#ctx.destination);
  }

  stop() {
    this.reset();
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#gain = null;
    ctx?.close().catch(() => {});
  }

  get blocked() {
    return !!this.#ctx && this.#ctx.state !== "running";
  }

  async resume() {
    if (this.#ctx?.state === "suspended") await this.#ctx.resume().catch(() => {});
    return !this.blocked;
  }

  setVolume(value) {
    this.#volume = Math.max(0, Math.min(1, value));
    if (this.#gain) this.#gain.gain.value = this.#volume;
  }

  setFormat({ sampleRate, channels }) {
    this.#format = { sampleRate, channels };
    this.#leftover = null;
  }

  reset() {
    this.#nextTime = 0;
    this.#leftover = null;
  }

  push(bytes) {
    const ctx = this.#ctx;
    // A suspended context does not advance its clock, so scheduling would queue audio without bound.
    if (!ctx || ctx.state !== "running" || !bytes.byteLength) return;
    if (this.#leftover) {
      const joined = new Uint8Array(this.#leftover.length + bytes.length);
      joined.set(this.#leftover);
      joined.set(bytes, this.#leftover.length);
      bytes = joined;
      this.#leftover = null;
    }
    const { sampleRate, channels } = this.#format;
    const frameBytes = 2 * channels;
    const frames = Math.floor(bytes.length / frameBytes);
    if (frames === 0) {
      this.#leftover = bytes;
      return;
    }
    const used = frames * frameBytes;
    if (used < bytes.length) this.#leftover = bytes.slice(used);

    const view = new DataView(bytes.buffer, bytes.byteOffset, used);
    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    for (let c = 0; c < channels; c++) {
      const out = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = view.getInt16((i * channels + c) * 2, true) / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    if (this.#nextTime < ctx.currentTime + MIN_LEAD_S || this.#nextTime > ctx.currentTime + MAX_LEAD_S) this.#nextTime = ctx.currentTime + START_BUFFER_S;
    source.start(this.#nextTime);
    this.#nextTime += buffer.duration;
  }
}
