/**
 * Pure helpers for the GM's room roster.
 *
 * Inputs:
 *  users:      [{ id, name }]                  Foundry players that should be in the room
 *  reports:    Map<userId, { state, clientId }> what each player's own client said it is doing
 *  guests:     [{ clientId, username }]         who the rooms server says is connected
 *  rejections: [{ username, rejectedAt }]       who the server turned away
 */

/** Per-player rows, in `users` order. `state`: joined | waiting | removed | error | idle | offline. */
export function buildPlayerRows(users, reports, guests) {
  const connected = new Set(guests.map((g) => g.clientId));
  return users.map((user) => {
    const report = reports.get(user.id);
    let state = report?.state ?? (user.active ? "idle" : "offline");
    // The server is the authority on who holds a slot.
    if (state === "joined" && report?.clientId && !connected.has(report.clientId)) state = "idle";
    return { id: user.id, name: user.name, state, clientId: state === "joined" ? report.clientId : null };
  });
}

/** Connected guests that no Foundry player claims: somebody who found the link. */
export function findStrangers(reports, guests) {
  const claimed = new Set([...reports.values()].map((r) => r.clientId).filter(Boolean));
  return guests.filter((g) => !claimed.has(g.clientId));
}

/** Rejections not seen before; `seen` is updated. Used to notify the GM exactly once per rejection. */
export function takeNewRejections(rejections, seen) {
  const fresh = [];
  for (const r of rejections) {
    const key = `${r.username}|${r.rejectedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(r);
  }
  return fresh;
}
