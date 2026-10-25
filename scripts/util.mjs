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

export const DOWNLOAD_URL = "https://slashpaf.com/audioforge/download";
