/**
 * useWhatIfBlocked - is creating something unavailable right now?
 *
 * Creation entry points are disabled while What-If mode is active (the POST
 * would only be queued, the server never assigns an id and the follow-up
 * reload shows nothing until Apply). Edits stay allowed.
 *
 *   const { blocked, reason } = useWhatIfBlocked();
 *   const createBlockedReason = !isEditing && blocked ? reason('Adding absences') : null;
 */

import { useCallback } from 'react';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';

export function useWhatIfBlocked(): { blocked: boolean; reason: (action: string) => string } {
  const blocked = useWhatIfStore((s) => s.whatIfMode);
  const reason = useCallback((action: string) => whatIfUnavailableMessage(action), []);
  return { blocked, reason };
}
