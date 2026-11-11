export function notifyFailure(err) {
  const message = err?.message ?? String(err);
  // The server gives up after 10 s when the app never registers the echo playback.
  const key = /echo playback did not start/i.test(message) ? "AUDIOFORGE.Notify.EchoScreen" : "AUDIOFORGE.Notify.Failed";
  ui.notifications.warn(game.i18n.format(key, { error: message }));
}

/**
 * Whether the panel and the profile editor list a category as a regular music or ambiance one. That is the anvil
 * switch in the app (`enabledInForge`), so a disabled category stays out even when it is not an echo. A category can
 * also be an echo (`oneShot`) at the same time, like Ghost, and then it shows in both lists.
 */
export const isRegular = (c) => c.enabledInForge !== false;

/**
 * A random UUID v4. `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost), and many tables open
 * Foundry over plain http on the local network; `crypto.getRandomValues` works everywhere.
 */
export function randomUuid(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const b = new Uint8Array(16);
  cryptoApi.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The rooms-server session id of this browser for one world and user. It identifies the guest on reconnects and carries
 * its control grant, so it must be unguessable: never derived from user ids, which every player can read.
 * `storage` is localStorage (or anything alike); without it the id lasts only for this page load.
 */
export function roomSessionId(storage, key) {
  try {
    const known = storage?.getItem(key);
    if (known) return known;
  } catch {
    // blocked storage: fall through to a fresh id
  }
  const id = `fvtt-${randomUuid()}`;
  try {
    storage?.setItem(key, id);
  } catch {
    // not persisted: the next reload joins as a new guest
  }
  return id;
}

/** Replace the stored session id by a fresh one (a new identity for the rooms server) and return it. */
export function resetRoomSessionId(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // blocked storage
  }
  return roomSessionId(storage, key);
}

export const DOWNLOAD_URL = "https://slashpaf.com/audioforge/download";
