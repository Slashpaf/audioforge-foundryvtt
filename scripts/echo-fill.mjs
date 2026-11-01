/**
 * Which echoes are playing and how far along, for the fill bars on echo tiles. Pure ES module (no Foundry, no DOM).
 * The panel is rebuilt on every push, so start times live here, keyed by playbackId, not in the DOM.
 */

/** Shortest fill, so a very short or unknown-length echo is still visible. Same as the Stream Deck plugin. */
export const MIN_FILL_MS = 400;
/** A known-length echo still listed this long after it should have ended is a missed stop: drop it. */
const STALE_GRACE_MS = 2000;

export class EchoTracker {
  #starts = new Map(); // playbackId -> { start, durationMs, categoryUuid }

  /** Take an `echoes` list received at `now`: new echoes start at now minus how far in they already are; absent ones are forgotten. */
  update(list, now = Date.now()) {
    const live = new Map();
    for (const e of Array.isArray(list) ? list : []) {
      if (e?.playbackId == null || !e.categoryUuid || e.remainingMs <= 0) continue;
      const known = this.#starts.get(e.playbackId);
      live.set(e.playbackId, known ?? {
        start: now - Math.max(0, e.positionMs ?? 0),
        durationMs: Math.max(MIN_FILL_MS, e.durationMs ?? 0),
        known: e.durationMs > 0,
        categoryUuid: e.categoryUuid,
      });
    }
    this.#starts = live;
  }

  clear() {
    this.#starts.clear();
  }

  /** Map categoryUuid -> [{ id, durationMs, elapsedMs }], one entry per playing echo so overlapping ones stack. */
  fills(now = Date.now()) {
    const out = new Map();
    for (const [id, e] of this.#starts) {
      const elapsedMs = Math.max(0, now - e.start);
      if (e.known && elapsedMs > e.durationMs + STALE_GRACE_MS) continue;
      if (!out.has(e.categoryUuid)) out.set(e.categoryUuid, []);
      out.get(e.categoryUuid).push({ id, durationMs: e.durationMs, elapsedMs: Math.round(Math.min(elapsedMs, e.durationMs)) });
    }
    return out;
  }
}
