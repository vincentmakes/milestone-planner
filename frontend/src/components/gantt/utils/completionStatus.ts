/**
 * Status that goes with a completion written from the Gantt completion slider.
 *
 * `status` and `completion` are two views of one thing (CLAUDE.md). The
 * backend derives the status in `apply_completion()`; the slider must apply
 * the same status locally, because the rich broadcast excludes the sender and
 * the user's own Kanban board would otherwise keep the stale column until a
 * reload. A status echoed by the server wins; otherwise (the update routes
 * answer `{success: true}`, What-If answers a fake success) it is derived with
 * the frontend mirror of `apply_completion()`.
 */
import { CARD_STATUSES, statusFromCompletion } from '@/utils/kanbanCards';
import type { CardStatus } from '@/types';

export function statusAfterCompletionWrite(
  response: unknown,
  completion: number | null,
  currentStatus: CardStatus | undefined
): CardStatus {
  const echoed = (response as { status?: unknown } | null | undefined)?.status;
  if (typeof echoed === 'string' && (CARD_STATUSES as string[]).includes(echoed)) {
    return echoed as CardStatus;
  }
  return statusFromCompletion(completion, currentStatus);
}
