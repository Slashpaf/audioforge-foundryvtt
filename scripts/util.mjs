export function notifyFailure(err) {
  const message = err?.message ?? String(err);
  // The server gives up after 10 s when the app never registers the echo playback.
  const key = /echo playback did not start/i.test(message) ? "AUDIOFORGE.Notify.EchoScreen" : "AUDIOFORGE.Notify.Failed";
  ui.notifications.warn(game.i18n.format(key, { error: message }));
}
