/**
 * Keep the first item of each id, in order.
 *
 * GET /equipment returns one row per equipment-site pair, so the store can
 * hold the same equipment several times. Views that are not filtered to a
 * single site use this to show each item once.
 */
export function uniqueById<T extends { id: number }>(items: readonly T[]): T[] {
  const seen = new Set<number>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
