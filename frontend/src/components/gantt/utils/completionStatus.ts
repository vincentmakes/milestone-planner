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
import { daysBetweenDateStrings } from '@/utils/date';
import type { CardStatus, Phase, Subphase } from '@/types';

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

/**
 * A phase's or subphase's completion as the Gantt shows it: once a child has
 * a value (its own or calculated), the duration-weighted average of the
 * children, unset ones counting 0% (`isCalculated`: read-only, the slider is
 * not offered); otherwise the item's own completion.
 */
export function effectiveCompletion(item: Phase | Subphase): { completion: number | null; isCalculated: boolean } {
  const children: Subphase[] = item.children ?? [];
  if (children.some((child) => effectiveCompletion(child).completion !== null)) {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const child of children) {
      const days = Math.max(1, daysBetweenDateStrings(child.start_date, child.end_date));
      weightedSum += (effectiveCompletion(child).completion ?? 0) * days;
      totalWeight += days;
    }
    return { completion: Math.round(weightedSum / totalWeight), isCalculated: true };
  }
  return { completion: item.completion ?? null, isCalculated: false };
}
