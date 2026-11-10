/**
 * Pure helpers for the GM's room roster.
 *
 * Inputs:
 *  users:      [{ id, name }]                  Foundry players that should be in the room
 *  reports:    Map<userId, { state, clientId }> what each player's own client said it is doing
 *  guests:     [{ clientId, username, permission? }]         who the rooms server says is connected
 *  rejections: [{ username, rejectedAt }]       who the server turned away
 */

/**
 * How a guest may use Audio Forge, from the app's guest entry: `mode` listen | control | roles, and in roles mode the
 * assigned `roleIds` and `roleNames` (a guest in roles mode with none behaves like listen).
 */
export function accessOf(guest) {
  const mode = guest?.permission === "control" || guest?.permission === "roles" ? guest.permission : "listen";
  const roleIds = mode === "roles" && Array.isArray(guest.roleIds) ? guest.roleIds : [];
  const roleNames = mode === "roles" && Array.isArray(guest.roleNames) ? guest.roleNames : [];
  return { mode, isRoles: mode === "roles", roleIds, roleNames, roleLabel: roleNames.join(", ") };
}

/** Roles of the room as checkbox entries for one guest. `roles`: [{ id, name }] or null/absent when the app has none. */
export function roleChoices(roles, roleIds) {
  if (!Array.isArray(roles)) return [];
  return roles.map((r) => ({ id: r.id, name: r.name, checked: roleIds.includes(r.id) }));
}

/** Per-player rows, in `users` order. `state`: joined | waiting | removed | error | idle | offline. */
export function buildPlayerRows(users, reports, guests) {
  const connected = new Set(guests.map((g) => g.clientId));
  const control = new Set(guests.filter((g) => g.permission === "control").map((g) => g.clientId));
  const byId = new Map(guests.map((g) => [g.clientId, g]));
  return users.map((user) => {
    const report = reports.get(user.id);
    let state = report?.state ?? (user.active ? "idle" : "offline");
    // The server is the authority on who holds a slot.
    if (state === "joined" && report?.clientId && !connected.has(report.clientId)) state = "idle";
    const clientId = state === "joined" ? report.clientId : null;
    return { id: user.id, name: user.name, state, clientId, canControl: control.has(clientId), ...accessOf(byId.get(clientId)) };
  });
}

/** Connected guests that no Foundry player claims: somebody who found the link. */
export function findStrangers(reports, guests) {
  const claimed = new Set([...reports.values()].map((r) => r.clientId).filter(Boolean));
  return guests.filter((g) => !claimed.has(g.clientId)).map((g) => ({ ...g, canControl: g.permission === "control", ...accessOf(g) }));
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
