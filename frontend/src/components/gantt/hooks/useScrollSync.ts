/**
 * useScrollSync Hook
 * Synchronizes vertical scroll between project panel and timeline
 * Both containers MUST have the same content height for proper alignment
 */

import { useEffect, useCallback, RefObject } from 'react';

export function useScrollSync(
  projectPanelRef: RefObject<HTMLDivElement>,
  timelineRef: RefObject<HTMLDivElement>
) {
  const syncScroll = useCallback(
    (source: 'project' | 'timeline', scrollTop: number) => {
      if (source === 'project' && timelineRef.current) {
        timelineRef.current.scrollTop = scrollTop;
      } else if (source === 'timeline' && projectPanelRef.current) {
        projectPanelRef.current.scrollTop = scrollTop;
      }
    },
    [projectPanelRef, timelineRef]
  );

  useEffect(() => {
    const projectPanel = projectPanelRef.current;
    const timeline = timelineRef.current;

    if (!projectPanel || !timeline) return;

    let isScrolling = false;

    const handleProjectScroll = () => {
      if (isScrolling) return;
      isScrolling = true;
      syncScroll('project', projectPanel.scrollTop);
      requestAnimationFrame(() => {
        isScrolling = false;
      });
    };

    const handleTimelineScroll = () => {
      if (isScrolling) return;
      isScrolling = true;
      syncScroll('timeline', timeline.scrollTop);
      requestAnimationFrame(() => {
        isScrolling = false;
      });
    };

    projectPanel.addEventListener('scroll', handleProjectScroll, { passive: true });
    timeline.addEventListener('scroll', handleTimelineScroll, { passive: true });

    return () => {
      projectPanel.removeEventListener('scroll', handleProjectScroll);
      timeline.removeEventListener('scroll', handleTimelineScroll);
    };
  }, [projectPanelRef, timelineRef, syncScroll]);
}
