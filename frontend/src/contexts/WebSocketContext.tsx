/**
 * WebSocket Context Provider
 * 
 * Provides WebSocket connection state and real-time data
 * to the entire application.
 */

import React, { createContext, useContext, useCallback, useMemo, useEffect, useRef } from 'react';
import { useWebSocket, ConnectionState } from '@/hooks/useWebSocket';
import type { PresenceUser, ChangePayload } from '@/hooks/useWebSocket';
import { loadAllProjects } from '@/api/endpoints/projects';
import { getStaff } from '@/api/endpoints/staff';
import { getEquipment, getEquipmentBlocks } from '@/api/endpoints/equipment';
import { getVacations } from '@/api/endpoints/vacations';
import { getSites } from '@/api/endpoints/sites';
import { skillsApi } from '@/api/endpoints/skills';
import { tagsApi } from '@/api/endpoints/tags';
import { useAppStore } from '@/stores/appStore';

// Re-export types for convenience
export type { PresenceUser, ChangePayload } from '@/hooks/useWebSocket';

interface WebSocketContextValue {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether connected to WebSocket */
  isConnected: boolean;
  /** List of online users (excluding self) */
  onlineUsers: PresenceUser[];
  /** Recent changes from other users */
  recentChanges: ChangePayload[];
  /** Get changes for a specific entity */
  getChangesForEntity: (entityType: string, entityId: number) => ChangePayload[];
  /** Check if an entity was recently changed by another user */
  isRecentlyChanged: (entityType: string, entityId: number) => boolean;
  /** Manually reconnect */
  reconnect: () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

interface WebSocketProviderProps {
  children: React.ReactNode;
}

/** Map an entity_type from the server to the data slice that needs to be reloaded. */
type Slice =
  | 'projects'
  | 'staff'
  | 'equipment'
  | 'equipmentBlocks'
  | 'vacations'
  | 'sites'
  | 'skills'
  | 'tags';

function slicesForEntity(entityType: string): Slice[] {
  switch (entityType) {
    // Project tree (and assignments live inside projects)
    case 'project':
    case 'phase':
    case 'subphase':
    case 'assignment':            // legacy generic, kept for back-compat
    case 'staff_assignment':
    case 'equipment_assignment':
    case 'predefined_phase':
    case 'note':
    case 'custom_column':
    case 'bank_holiday':
    case 'company_event':
      return ['projects'];
    case 'staff':
    case 'user':
      return ['staff', 'projects'];
    case 'equipment':
      return ['equipment', 'projects'];
    case 'equipment_block':
      return ['equipmentBlocks'];
    case 'vacation':
      return ['vacations'];
    case 'site':
      return ['sites'];
    case 'skill':
      return ['skills', 'staff'];
    case 'tag':
      return ['tags', 'projects'];
    default:
      // Unknown type: refresh everything to be safe.
      return ['projects', 'staff', 'equipment', 'equipmentBlocks', 'vacations', 'sites', 'skills', 'tags'];
  }
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const setProjects = useAppStore((s) => s.setProjects);
  const setStaff = useAppStore((s) => s.setStaff);
  const setEquipment = useAppStore((s) => s.setEquipment);
  const setEquipmentBlocks = useAppStore((s) => s.setEquipmentBlocks);
  const setVacations = useAppStore((s) => s.setVacations);
  const setSites = useAppStore((s) => s.setSites);
  const setSkills = useAppStore((s) => s.setSkills);
  const setTags = useAppStore((s) => s.setTags);

  // Debounce refresh to avoid multiple rapid requests
  const refreshTimeoutRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  // Set of slices to reload on the next refresh tick. Cascaded broadcasts
  // (e.g. a phase drag that produces N child subphase updates) collapse into
  // a single fetch per slice this way.
  const pendingSlicesRef = useRef<Set<Slice>>(new Set());
  // If a change arrives while we're already refreshing, schedule another pass.
  const restageRef = useRef<Set<Slice>>(new Set());

  const runRefresh = useCallback(async () => {
    if (inFlightRef.current) return;
    const slices = pendingSlicesRef.current;
    if (slices.size === 0) return;

    inFlightRef.current = true;
    const batch = Array.from(slices);
    pendingSlicesRef.current = new Set();

    console.info('[WS] refreshing slices', batch);

    const tasks: Array<Promise<unknown>> = [];
    for (const slice of batch) {
      switch (slice) {
        case 'projects':
          tasks.push(loadAllProjects().then(setProjects).catch((e) => console.error('[WS] projects refresh failed', e)));
          break;
        case 'staff':
          tasks.push(getStaff(true).then(setStaff).catch((e) => console.error('[WS] staff refresh failed', e)));
          break;
        case 'equipment':
          tasks.push(getEquipment(true).then(setEquipment).catch((e) => console.error('[WS] equipment refresh failed', e)));
          break;
        case 'equipmentBlocks':
          tasks.push(getEquipmentBlocks().then(setEquipmentBlocks).catch((e) => console.error('[WS] equipment blocks refresh failed', e)));
          break;
        case 'vacations':
          tasks.push(getVacations().then(setVacations).catch((e) => console.error('[WS] vacations refresh failed', e)));
          break;
        case 'sites':
          tasks.push(getSites().then(setSites).catch((e) => console.error('[WS] sites refresh failed', e)));
          break;
        case 'skills':
          tasks.push(skillsApi.getAll().then(setSkills).catch((e) => console.error('[WS] skills refresh failed', e)));
          break;
        case 'tags':
          tasks.push(tagsApi.getAll().then(setTags).catch((e) => console.error('[WS] tags refresh failed', e)));
          break;
      }
    }

    await Promise.all(tasks);
    inFlightRef.current = false;

    // If more changes came in during the fetch, immediately restage them.
    if (restageRef.current.size > 0) {
      const next = restageRef.current;
      restageRef.current = new Set();
      for (const s of next) pendingSlicesRef.current.add(s);
      runRefresh();
    }
  }, [setProjects, setStaff, setEquipment, setEquipmentBlocks, setVacations, setSites, setSkills, setTags]);

  const handleChangeReceived = useCallback((change: ChangePayload) => {
    const target = inFlightRef.current ? restageRef.current : pendingSlicesRef.current;
    for (const slice of slicesForEntity(change.entity_type)) {
      target.add(slice);
    }

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    // Short debounce so a burst of drag-related updates collapses into a single
    // refresh, but the receiving user still feels the change near-instantly.
    refreshTimeoutRef.current = window.setTimeout(runRefresh, 200);
  }, [runRefresh]);
  
  const {
    connectionState,
    onlineUsers,
    recentChanges,
    connect,
    disconnect,
  } = useWebSocket({
    autoConnect: true,
    onChangeReceived: handleChangeReceived,
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const isConnected = connectionState === 'connected';

  const getChangesForEntity = useCallback(
    (entityType: string, entityId: number): ChangePayload[] => {
      return recentChanges.filter(
        c => c.entity_type === entityType && c.entity_id === entityId
      );
    },
    [recentChanges]
  );

  const isRecentlyChanged = useCallback(
    (entityType: string, entityId: number): boolean => {
      return recentChanges.some(
        c => c.entity_type === entityType && c.entity_id === entityId
      );
    },
    [recentChanges]
  );

  const reconnect = useCallback(() => {
    disconnect();
    setTimeout(connect, 100);
  }, [connect, disconnect]);

  const value = useMemo<WebSocketContextValue>(
    () => ({
      connectionState,
      isConnected,
      onlineUsers,
      recentChanges,
      getChangesForEntity,
      isRecentlyChanged,
      reconnect,
    }),
    [
      connectionState,
      isConnected,
      onlineUsers,
      recentChanges,
      getChangesForEntity,
      isRecentlyChanged,
      reconnect,
    ]
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

/**
 * Hook to access WebSocket context
 */
export function useWebSocketContext(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return context;
}

/**
 * Hook to get online users (convenience wrapper)
 */
export function useOnlineUsers(): PresenceUser[] {
  const { onlineUsers } = useWebSocketContext();
  return onlineUsers;
}
