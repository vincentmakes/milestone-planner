/**
 * useScrollSync Hook
 * Synchronizes vertical scroll position between two elements
 */

import { useEffect, RefObject } from 'react';

export function useScrollSync(
  ref1: RefObject<HTMLElement>,
  ref2: RefObject<HTMLElement>
) {
  useEffect(() => {
    const el1 = ref1.current;
    const el2 = ref2.current;

    if (!el1 || !el2) return;

    let isSyncing = false;

    const handleScroll1 = () => {
      if (isSyncing) return;
      isSyncing = true;
      el2.scrollTop = el1.scrollTop;
      requestAnimationFrame(() => {
        isSyncing = false;
      });
    };

    const handleScroll2 = () => {
      if (isSyncing) return;
      isSyncing = true;
      el1.scrollTop = el2.scrollTop;
      requestAnimationFrame(() => {
        isSyncing = false;
      });
    };

    el1.addEventListener('scroll', handleScroll1, { passive: true });
    el2.addEventListener('scroll', handleScroll2, { passive: true });

    return () => {
      el1.removeEventListener('scroll', handleScroll1);
      el2.removeEventListener('scroll', handleScroll2);
    };
  }, [ref1, ref2]);
}
