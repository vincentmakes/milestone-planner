/**
 * FlashNotice — the app-wide slot for a message that has no form to sit in
 * (a context-menu delete that failed, a refused dependency link, a Kanban
 * move the server rejected). Anything with its own form or panel shows a
 * `Notice` in place instead; this is only for those detached actions.
 *
 * Driven by `uiStore.flashNotice` (`showFlash` / `dismissFlash`). It renders
 * bottom-right, above the activity feed, and clears itself after a few
 * seconds unless dismissed first.
 */

import { useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { Notice } from '@/components/common/Notice';
import styles from './FlashNotice.module.css';

export const FLASH_DURATION_MS = 6000;

export function FlashNotice() {
  const flash = useUIStore((s) => s.flashNotice);
  const dismissFlash = useUIStore((s) => s.dismissFlash);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => dismissFlash(flash.id), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flash, dismissFlash]);

  if (!flash) return null;

  return (
    <div className={styles.slot}>
      <Notice tone={flash.tone} role="alert" onDismiss={() => dismissFlash(flash.id)}>
        {flash.message}
      </Notice>
    </div>
  );
}
