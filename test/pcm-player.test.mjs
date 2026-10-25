import test from "node:test";
import assert from "node:assert/strict";
import { PcmPlayer } from "../scripts/rooms/pcm-player.mjs";

/** Just enough Web Audio to see when and how much gets scheduled. */
function fakeAudio(state = "running") {
  const ctx = {
    state,
    currentTime: 0,
    starts: [],
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBuffer: (channels, frames, rate) => ({ duration: frames / rate, getChannelData: () => new Float32Array(frames) }),
    createBufferSource: () => ({ connect() {}, start: (t) => ctx.starts.push(t) }),
    close: async () => {},
    resume: async () => {
      ctx.state = "running";
    },
  };
  globalThis.AudioContext = function () {
    return ctx;
  };
  return ctx;
}

const second = new Uint8Array(8000 * 2 * 2); // 1 s of 8 kHz stereo PCM16

test("nothing is queued while the context is suspended", () => {
  const ctx = fakeAudio("suspended");
  const p = new PcmPlayer();
  p.start();
  p.setFormat({ sampleRate: 8000, channels: 2 });
  for (let i = 0; i < 100; i++) p.push(second);
  assert.equal(ctx.starts.length, 0);
});

test("chunks are scheduled back to back behind a start buffer", () => {
  const ctx = fakeAudio();
  const p = new PcmPlayer();
  p.start();
  p.setFormat({ sampleRate: 8000, channels: 2 });
  p.push(second);
  p.push(second);
  assert.equal(ctx.starts[0], 1);
  assert.equal(ctx.starts[1], 2);
});

test("a fast host cannot build an ever-growing delay", () => {
  const ctx = fakeAudio();
  const p = new PcmPlayer();
  p.start();
  p.setFormat({ sampleRate: 8000, channels: 2 });
  for (let i = 0; i < 10; i++) p.push(second);
  assert.ok(Math.max(...ctx.starts) - ctx.currentTime <= 3.5);
});
