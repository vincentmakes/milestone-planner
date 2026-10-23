/**
 * The @-mention picker's people, per site, for the session.
 *
 * A comment thread shows in dialogs that unmount on close (the booking
 * dialog), so the list is cached here rather than in component state: one
 * request per site until the cache is cleared. `resetAllStores` clears it
 * (sign-out), and so does the WebSocket refresh of the staff or roles slices
 * (someone joined, left or changed role). A failed load is not cached.
 *
 * Deliberately free of imports: the loader is passed in, so a test that
 * mocks the kanban endpoints still drives it, and the store reset can clear
 * it without loading the endpoints.
 */

export interface CachedMentionableUser {
  id: number;
  name: string;
  job_title: string | null;
}

const cache = new Map<number, Promise<CachedMentionableUser[]>>();

/** The site's mentionable people, loaded once per site through `load`. */
export function mentionableUsersFor(
  siteId: number,
  load: (siteId: number) => Promise<CachedMentionableUser[]>
): Promise<CachedMentionableUser[]> {
  let entry = cache.get(siteId);
  if (!entry) {
    entry = load(siteId);
    cache.set(siteId, entry);
    entry.catch(() => {
      if (cache.get(siteId) === entry) cache.delete(siteId);
    });
  }
  return entry;
}

/** Forget every cached list (sign-out, people or roles changed). */
export function clearMentionableUsersCache(): void {
  cache.clear();
}
