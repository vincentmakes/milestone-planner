/**
 * useReportDirty - tell the Settings hub whether a panel holds unsaved input.
 *
 * The hub asks before switching section or closing while the flag is set
 * (SettingsHub's onDirtyChange). Call it once per panel with one combined
 * flag: the hub keeps a single boolean, so two reporters in the same panel
 * would overwrite each other. The flag is cleared when the caller unmounts
 * (form saved, cancelled or closed).
 *
 * `onDirtyChange` is optional so panels can be rendered on their own (tests).
 */

import { useEffect } from 'react';

export function useReportDirty(
  onDirtyChange: ((dirty: boolean) => void) | undefined,
  dirty: boolean
): void {
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
}
