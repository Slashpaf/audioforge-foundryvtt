/**
 * Which echoes are playing and how far along, for the fill bars on echo tiles. Pure ES module (no Foundry, no DOM).
 * The panel is rebuilt on every push, so start times live here, keyed by playbackId, not in the DOM.
 */

/** Shortest fill, so a very short or unknown-length echo is still visible. Same as the Stream Deck plugin. */
export const MIN_FILL_MS = 400;
/** After the bar is full it is wiped out from left to right over this long, like Audio Forge's own tile. */
export const WIPE_MS = 200;
/** Slack after the wipe before the layer is dropped, and how early a vanished echo may be before it counts as stopped. */
const GRACE_MS = 100;
const STOPPED_EARLY_MS = 300;
/** A known-length echo still listed this long after it should have ended is a missed stop: drop it. */
const STALE_GRACE_MS = 2000;
const NEVER_MS = 3_600_000;

export class EchoTracker {
  #starts = new Map(); // playbackId -> { start, durationMs, categoryUuid }

  /** Take an `echoes` list received at `now`: new echoes start at now minus how far in they already are. */
  update(list, now = Date.now()) {
    const live = new Map();
    for (const e of Array.isArray(list) ? list : []) {
      if (e?.playbackId == null || !e.categoryUuid || e.remainingMs <= 0) continue;
      const known = this.#starts.get(e.playbackId);
      live.set(e.playbackId, known?.gone ? { ...known, gone: false } : known ?? {
        start: now - Math.max(0, e.positionMs ?? 0),
        durationMs: Math.max(MIN_FILL_MS, e.durationMs ?? 0),
        known: e.durationMs > 0,
        categoryUuid: e.categoryUuid,
      });
    }
    // An echo that left the list is wiped out, not cut: one that ended on time finishes its wipe, an unknown-length
    // one starts it now, and one stopped well before its end disappears at once.
    for (const [id, e] of this.#starts) {
      if (live.has(id)) continue;
      if (e.gone) {
        live.set(id, e);
      } else if (!e.known) {
        live.set(id, { ...e, start: now - e.durationMs, gone: true });
      } else if (now >= e.start + e.durationMs - STOPPED_EARLY_MS) {
        live.set(id, { ...e, gone: true });
      }
    }
    this.#starts = live;
  }

  clear() {
    this.#starts.clear();
  }

  /**
   * Map categoryUuid -> [{ id, durationMs, elapsedMs, wipeDelayMs }], one entry per echo so overlapping ones stack.
   * `wipeDelayMs` (negative once the wipe has started) is when the wipe begins relative to now; `remainingMs` is how long
   * the layer is still needed. Echoes whose wipe is over are left out.
   */
  fills(now = Date.now()) {
    const out = new Map();
    for (const [id, e] of this.#starts) {
      const elapsedMs = Math.max(0, now - e.start);
      const end = e.durationMs + WIPE_MS;
      // Unknown length and still listed: stay full until the host drops it (then the wipe starts).
      const open = !e.known && !e.gone;
      if (!open && elapsedMs > end + GRACE_MS) continue;
      if (e.known && !e.gone && elapsedMs > e.durationMs + STALE_GRACE_MS) continue;
      if (!out.has(e.categoryUuid)) out.set(e.categoryUuid, []);
      out.get(e.categoryUuid).push({
        id,
        durationMs: e.durationMs,
        elapsedMs: Math.round(open ? Math.min(elapsedMs, e.durationMs) : elapsedMs),
        wipeDelayMs: open ? NEVER_MS : Math.round(e.durationMs - elapsedMs),
        remainingMs: open ? NEVER_MS : Math.max(0, Math.round(end - elapsedMs)),
      });
    }
    return out;
  }
}
