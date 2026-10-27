/**
 * Turns microphone blocks into the format the AI Director takes: 16 kHz, mono, signed 16-bit little-endian PCM.
 * No browser dependencies, so it can be tested under Node.
 */

export const TARGET_RATE = 16000;

/** Streaming downsampler (box filter over each output sample) that keeps its position between blocks. */
export class PcmConverter {
  #ratio;
  #acc = 0;
  #count = 0;
  #pos = 0;

  constructor(inputRate) {
    this.#ratio = inputRate / TARGET_RATE;
  }

  /** @param {Float32Array} input mono samples in -1..1. @returns {Int16Array} the samples completed by this block. */
  convert(input) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.#acc += input[i];
      this.#count++;
      this.#pos++;
      if (this.#pos >= this.#ratio) {
        const v = Math.max(-1, Math.min(1, this.#acc / this.#count));
        out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
        this.#pos -= this.#ratio;
        this.#acc = 0;
        this.#count = 0;
      }
    }
    return Int16Array.from(out);
  }
}

/** Little-endian bytes, whatever the platform's endianness. */
export function toLittleEndianBytes(samples) {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return buf;
}

/** Groups small blocks into ~100 ms frames so the socket is not flooded with tiny messages. */
export class PcmBatcher {
  #parts = [];
  #length = 0;
  #min;

  constructor(minSamples = TARGET_RATE / 10) {
    this.#min = minSamples;
  }

  /** @returns {ArrayBuffer | null} a frame once enough samples are collected. */
  push(samples) {
    this.#parts.push(samples);
    this.#length += samples.length;
    if (this.#length < this.#min) return null;
    const all = new Int16Array(this.#length);
    let at = 0;
    for (const part of this.#parts) {
      all.set(part, at);
      at += part.length;
    }
    this.#parts = [];
    this.#length = 0;
    return toLittleEndianBytes(all);
  }
}
