/**
 * usePresence Hook
 * 
 * Tracks which users are viewing/editing a project.
 * Sends heartbeats to maintain presence and shows other active viewers.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  sendPresenceHeartbeat, 
  leaveProject, 
  getSitePresence,
  PresenceUser 
} from '@/api/endpoints/presence';
import { useAppStore } from '@/stores/appStore';

// Heartbeat interval in milliseconds (30 seconds)
const HEARTBEAT_INTERVAL = 30000;

interface UsePresenceOptions {
  /** Whether the user is actively editing */
  isEditing?: boolean;
}

interface UsePresenceReturn {
  /** Other users viewing/editing this project (excludes current user) */
  viewers: PresenceUser[];
  /** Whether there are other editors (not just viewers) */
  hasOtherEditors: boolean;
  /** Manually refresh presence */
  refresh: () => Promise<void>;
  /** Set editing state */
  setEditing: (editing: boolean) => void;
}

/**
 * Hook to track presence on a specific project
 */
export function useProjectPresence(
  projectId: number | null,
  options: UsePresenceOptions = {}
): UsePresenceReturn {
  const [viewers, setViewers] = useState<PresenceUser[]>([]);
  const [isEditing, setIsEditing] = useState(options.isEditing ?? false);
  const intervalRef = useRef<number | null>(null);

  const sendHeartbeat = useCallback(async () => {
    if (!projectId) return;
    
    try {
      const response = await sendPresenceHeartbeat(
        projectId, 
        isEditing ? 'editing' : 'viewing'
      );
      setViewers(response.viewers);
    } catch (error) {
      console.warn('Failed to send presence heartbeat:', error);
    }
  }, [projectId, isEditing]);

  // Start/stop heartbeat when projectId changes
  useEffect(() => {
    if (!projectId) {
      setViewers([]);
      return;
    }

    // Send initial heartbeat
    sendHeartbeat();

    // Set up interval
    intervalRef.current = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

    // Cleanup on unmount or projectId change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // Notify server we're leaving
      leaveProject(projectId).catch(() => {
        // Ignore errors on leave
      });
    };
  }, [projectId, sendHeartbeat]);

  // Update heartbeat when editing state changes
  useEffect(() => {
    if (projectId) {
      sendHeartbeat();
    }
  }, [isEditing, projectId, sendHeartbeat]);

  const hasOtherEditors = viewers.some(v => v.activity === 'editing');

  return {
    viewers,
    hasOtherEditors,
    refresh: sendHeartbeat,
    setEditing: setIsEditing,
  };
}

/**
 * Hook to track presence across all projects in a site
 * Returns a map of project_id -> viewers
 */
export function useSitePresence(): {
  presenceMap: Record<number, PresenceUser[]>;
  refresh: () => Promise<void>;
} {
  const [presenceMap, setPresenceMap] = useState<Record<number, PresenceUser[]>>({});
  const currentSite = useAppStore((s) => s.currentSite);
  const intervalRef = useRef<number | null>(null);

  const fetchPresence = useCallback(async () => {
    if (!currentSite?.id) {
      setPresenceMap({});
      return;
    }

    try {
      const response = await getSitePresence(currentSite.id);
      setPresenceMap(response.presence);
    } catch (error) {
      console.warn('Failed to fetch site presence:', error);
    }
  }, [currentSite?.id]);

  useEffect(() => {
    if (!currentSite?.id) {
      setPresenceMap({});
      return;
    }

    // Fetch immediately
    fetchPresence();

    // Refresh every 30 seconds
    intervalRef.current = window.setInterval(fetchPresence, HEARTBEAT_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [currentSite?.id, fetchPresence]);

  return {
    presenceMap,
    refresh: fetchPresence,
  };
}

/**
 * Format viewers list for display
 */
export function formatViewersList(viewers: PresenceUser[]): string {
  if (viewers.length === 0) return '';
  
  const names = viewers.map(v => `${v.first_name} ${v.last_name}`);
  
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
