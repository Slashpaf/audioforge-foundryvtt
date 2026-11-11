/**
 * Paces volume commands: a slider can fire far more than the rooms server (about 30 commands a second per guest) or the
 * Local API should get. Per key (section|category) at most one command every VOLUME_PACE_MS, the newest value wins. A call
 * replaced by a newer one resolves right away (its value no longer matters), so a drag never reports a failure per event.
 */
export const VOLUME_PACE_MS = 150;

/** Highest display value for one category (gain 1.0). Above it the app rejects the value and can crash. */
export const CATEGORY_VOLUME_MAX = 0.5;

export function clampCategoryVolume(value) {
  const v = Number(value);
  return Number.isFinite(v) ? Math.min(CATEGORY_VOLUME_MAX, Math.max(0, v)) : 0;
}

export const volumeKey = (cmd) => `${cmd.section}|${cmd.categoryUuid ?? ""}`;

export class VolumePacer {
  #slots = new Map(); // key -> { sentAt, timer, command, waiters }

  /** `sendNow(command)` does the real send and returns a promise. */
  send(cmd, sendNow) {
    if (cmd.categoryUuid != null) cmd = { ...cmd, value: clampCategoryVolume(cmd.value) }; // never above what the app allows
    const key = volumeKey(cmd);
    const slot = this.#slots.get(key) ?? { sentAt: 0, timer: null, command: null, waiters: [] };
    this.#slots.set(key, slot);
    return new Promise((resolve, reject) => {
      for (const w of slot.waiters) w.resolve({ type: "result", ok: true, superseded: true });
      slot.waiters = [{ resolve, reject }];
      slot.command = cmd;
      if (slot.timer) return;
      const flush = () => {
        slot.timer = null;
        slot.sentAt = Date.now();
        const { command, waiters } = slot;
        slot.waiters = [];
        sendNow(command).then(
          (r) => waiters.forEach((w) => w.resolve(r)),
          (e) => waiters.forEach((w) => w.reject(e)),
        );
      };
      const wait = slot.sentAt + VOLUME_PACE_MS - Date.now();
      if (wait <= 0) flush();
      else slot.timer = setTimeout(flush, wait);
    });
  }

  /** Fail everything still waiting (the connection went away). */
  rejectAll(error) {
    for (const slot of this.#slots.values()) {
      clearTimeout(slot.timer);
      slot.timer = null;
      for (const w of slot.waiters) w.reject(error);
      slot.waiters = [];
    }
  }
}
