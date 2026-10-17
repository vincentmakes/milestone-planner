/**
 * Chunked bulk imports.
 *
 * The bulk-import routes (`/vacations/import`, `/sites/{id}/holidays/import`,
 * `/events/import`) reject more than 1 000 items per request (422). A large
 * .ics file can hold more, so the importers send it in sequential slices and
 * add up the counts — the UI sees one result, as if it were a single call.
 */

/** Items per request — well under the backend's `MAX_IMPORT_ITEMS` (1 000). */
export const IMPORT_CHUNK_SIZE = 500;

export interface ChunkedImportResult {
  created: number;
  skipped: number;
  linked?: number;
}

/**
 * Send `items` through `send` in slices of `size`, one request at a time, and
 * return the summed `created` / `skipped` (and `linked`, only when a response
 * carries it). A list that fits in one slice (an empty one included) is sent
 * as a single call and its result returned unchanged.
 *
 * If a slice fails after earlier ones succeeded, the error says how many items
 * were already imported; the server skips duplicates, so retrying the whole
 * import is safe.
 */
export async function postInChunks<TItem, TResult extends ChunkedImportResult>(
  items: TItem[],
  send: (chunk: TItem[]) => Promise<TResult>,
  size: number = IMPORT_CHUNK_SIZE
): Promise<ChunkedImportResult> {
  if (items.length <= size) return send(items);

  const total: ChunkedImportResult = { created: 0, skipped: 0 };
  let linked: number | undefined;
  let processed = 0;
  for (let start = 0; start < items.length; start += size) {
    const chunk = items.slice(start, start + size);
    let result: TResult;
    try {
      result = await send(chunk);
    } catch (err) {
      if (processed === 0) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Import stopped after ${processed} of ${items.length} items ` +
          `(${total.created} created, ${total.skipped} skipped): ${reason}. ` +
          'Retrying is safe — items already imported are skipped.'
      );
    }
    total.created += result.created ?? 0;
    total.skipped += result.skipped ?? 0;
    if (result.linked !== undefined) linked = (linked ?? 0) + result.linked;
    processed += chunk.length;
  }
  if (linked !== undefined) total.linked = linked;
  return total;
}
