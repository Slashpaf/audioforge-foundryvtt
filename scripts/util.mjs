export function notifyFailure(err) {
  const message = err?.message ?? String(err);
  // The server gives up after 10 s when the app never registers the echo playback.
  const key = /echo playback did not start/i.test(message) ? "AUDIOFORGE.Notify.EchoScreen" : "AUDIOFORGE.Notify.Failed";
  ui.notifications.warn(game.i18n.format(key, { error: message }));
}

/**
 * A category can be both an echo (oneShot) and a regular ambiance category. The app lists it as a regular one when it
 * is enabled in the Forge, and hides only the pure echoes.
 */
export const isRegular = (c) => c.enabledInForge !== false || !c.oneShot;
