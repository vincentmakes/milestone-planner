/**
 * TimelineScrollContext
 * 
 * Provides synchronized horizontal scrolling between multiple timeline components
 * (e.g., Gantt chart and Staff Overview).
 * 
 * Uses direct DOM manipulation for smooth, lag-free synchronization.
 */

import { createContext, useContext, useCallback, useRef, useEffect, type ReactNode } from 'react';

interface TimelineScrollContextValue {
  registerScrollContainer: (id: string, ref: React.RefObject<HTMLDivElement>) => void;
  unregisterScrollContainer: (id: string) => void;
  syncScroll: (sourceId: string, scrollLeft: number) => void;
  getScrollLeft: () => number;
}

const TimelineScrollContext = createContext<TimelineScrollContextValue | null>(null);

interface TimelineScrollProviderProps {
  children: ReactNode;
}

export function TimelineScrollProvider({ children }: TimelineScrollProviderProps) {
  const containersRef = useRef<Map<string, React.RefObject<HTMLDivElement>>>(new Map());
  const lastScrollLeftRef = useRef(0);
  const scrollSourceRef = useRef<string | null>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Register a scroll container
  const registerScrollContainer = useCallback((id: string, ref: React.RefObject<HTMLDivElement>) => {
    containersRef.current.set(id, ref);
    
    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      // If this is a new container and we have existing ones, sync from the first one
      if (containersRef.current.size > 1 && ref.current) {
        // Find another container to sync from
        for (const [otherId, otherRef] of containersRef.current) {
          if (otherId !== id && otherRef.current) {
            const scrollLeft = otherRef.current.scrollLeft;
            if (scrollLeft > 0) {
              lastScrollLeftRef.current = scrollLeft;
              ref.current.scrollLeft = scrollLeft;
            }
            break;
          }
        }
      } else if (ref.current && lastScrollLeftRef.current > 0) {
        // Sync new container to stored scroll position
        ref.current.scrollLeft = lastScrollLeftRef.current;
      }
    });
  }, []);

  // Unregister a scroll container
  const unregisterScrollContainer = useCallback((id: string) => {
    containersRef.current.delete(id);
  }, []);

  // Sync all containers to a scroll position (called by source container)
  const syncScroll = useCallback((sourceId: string, scrollLeft: number) => {
    // If we're currently syncing from a different source, ignore
    // This prevents feedback loops
    if (scrollSourceRef.current && scrollSourceRef.current !== sourceId) {
      return;
    }
    
    // Mark this container as the scroll source
    scrollSourceRef.current = sourceId;
    lastScrollLeftRef.current = scrollLeft;

    // Sync all other containers directly via DOM
    containersRef.current.forEach((ref, id) => {
      if (id !== sourceId && ref.current) {
        ref.current.scrollLeft = scrollLeft;
      }
    });

    // Clear the scroll source after scrolling settles
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      scrollSourceRef.current = null;
    }, 100);
  }, []);

  // Get current scroll position
  const getScrollLeft = useCallback(() => lastScrollLeftRef.current, []);

  return (
    <TimelineScrollContext.Provider value={{ 
      registerScrollContainer, 
      unregisterScrollContainer, 
      syncScroll,
      getScrollLeft 
    }}>
      {children}
    </TimelineScrollContext.Provider>
  );
}

/**
 * Hook to register a scroll container and get sync handler
 * Must be called unconditionally (React hooks rule)
 */
export function useTimelineScrollSync(id: string, scrollRef: React.RefObject<HTMLDivElement>, enabled: boolean = true) {
  const context = useContext(TimelineScrollContext);
  const syncScrollPositionRef = useRef<(scrollLeft: number) => void>(() => {});

  // Update ref when context changes
  useEffect(() => {
    syncScrollPositionRef.current = (scrollLeft: number) => {
      if (!context || !enabled) return;
      context.syncScroll(id, scrollLeft);
    };
  }, [context, id, enabled]);

  // Register/unregister this container and sync initial position
  useEffect(() => {
    if (!context || !enabled) return;
    
    context.registerScrollContainer(id, scrollRef);
    
    // Sync to current scroll position on mount (after DOM is ready)
    requestAnimationFrame(() => {
      const currentScrollLeft = context.getScrollLeft();
      if (scrollRef.current && currentScrollLeft > 0) {
        scrollRef.current.scrollLeft = currentScrollLeft;
      }
    });
    
    return () => context.unregisterScrollContainer(id);
  }, [context, id, scrollRef, enabled]);

  // Create scroll handler that syncs other containers
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!context || !enabled) return;
    context.syncScroll(id, e.currentTarget.scrollLeft);
  }, [context, id, enabled]);

  // Stable function that uses ref internally
  const syncScrollPosition = useCallback((scrollLeft: number) => {
    syncScrollPositionRef.current(scrollLeft);
  }, []);

  return { handleScroll, syncScrollPosition };
}

/**
 * Hook to get scroll context value (safe to call outside provider)
 * Returns null functions if outside provider
 */
export function useTimelineScrollValue() {
  const context = useContext(TimelineScrollContext);
  
  if (!context) {
    return { 
      syncScroll: undefined as ((sourceId: string, scrollLeft: number) => void) | undefined,
      getScrollLeft: () => 0 
    };
  }

  return { 
    syncScroll: context.syncScroll, 
    getScrollLeft: context.getScrollLeft 
  };
}
