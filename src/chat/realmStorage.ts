// Privacy fix (per-user realms): renderer-side storage that is keyed by a
// conversation id must also be keyed by the signed-in user's realm.
// Conversation ids restart at 1 in every realm database, so an unscoped
// key would hand the previous user's per-conversation state (folder
// selection, shown suggestions) to the next user's conversation with the
// same id. The realm is the opaque hash the core reports in
// `ProfileOverview.active_user.realm` (never the raw user id).

/** `base` scoped to `realm`; the bare `base` when there is no realm. */
export function realmScopedKey(base: string, realm: string): string {
  return realm ? `${base}:${realm}` : base;
}
