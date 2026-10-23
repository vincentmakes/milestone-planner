/**
 * WebSocket Context Provider
 * 
 * Provides WebSocket connection state and real-time data
 * to the entire application.
 */

import React, { createContext, useContext, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNotificationStore } from '@/stores/notificationStore';
import { useWorkStore } from '@/stores/workStore';
import { useWebSocket, ConnectionState } from '@/hooks/useWebSocket';
import type { PresenceUser, ChangePayload } from '@/hooks/useWebSocket';
import type { AppNotification } from '@/types';
import { loadAllProjects } from '@/api/endpoints/projects';
import { getStaff } from '@/api/endpoints/staff';
import { getEquipment, getEquipmentBlocks } from '@/api/endpoints/equipment';
import { loadGated } from '@/hooks/useDataLoader';
import { getVacations } from '@/api/endpoints/vacations';
import {
  getSites,
  getBankHolidays,
  getCompanyEvents,
  buildHolidayDateSet,
  buildEventDateSet,
} from '@/api/endpoints/sites';
import { skillsApi } from '@/api/endpoints/skills';
import { tagsApi } from '@/api/endpoints/tags';
import { projectFieldsApi } from '@/api/endpoints/projectFields';
import { teamsApi } from '@/api/endpoints/teams';
import { rolesApi } from '@/api/endpoints/roles';
import { refreshApprovalPoliciesIfLoaded } from '@/hooks/useApprovalPolicies';
import { absenceTypesApi } from '@/api/endpoints/absenceTypes';
import { getCustomColumnsWithValues } from '@/api/endpoints/customColumns';
import { getInstanceSettings } from '@/api/endpoints/settings';
import { fetchCurrentUser } from '@/api/endpoints/auth';
import { useAppStore } from '@/stores/appStore';
import { expireSession } from '@/stores';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { slicesForEntity, WHAT_IF_SANDBOXED_SLICES } from './wsSlices';
import type { Slice } from './wsSlices';

// Re-export types for convenience
export type { PresenceUser, ChangePayload } from '@/hooks/useWebSocket';

interface WebSocketContextValue {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether connected to WebSocket */
  isConnected: boolean;
  /**
   * Live sync is down right now (browser offline, or the socket dropped and
   * has not come back yet). For a small header indicator; see useWebSocket.
   */
  offline: boolean;
  /** List of online users (excluding self) */
  onlineUsers: PresenceUser[];
  /** Recent changes from other users */
  recentChanges: ChangePayload[];
  /** Manually reconnect */
  reconnect: () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

interface WebSocketProviderProps {
  children: React.ReactNode;
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
  const setProjectFields = useAppStore((s) => s.setProjectFields);
  const setTeams = useAppStore((s) => s.setTeams);
  const setRoles = useAppStore((s) => s.setRoles);
  const setAbsenceTypes = useAppStore((s) => s.setAbsenceTypes);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const setCompanyEvents = useAppStore((s) => s.setCompanyEvents);
  const setInstanceSettings = useAppStore((s) => s.setInstanceSettings);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);

  // Debounce refresh to avoid multiple rapid requests
  const refreshTimeoutRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  // Set of slices to reload on the next refresh tick. Cascaded broadcasts
  // (e.g. a phase drag that produces N child subphase updates) collapse into
  // a single fetch per slice this way.
  const pendingSlicesRef = useRef<Set<Slice>>(new Set());
  // If a change arrives while we're already refreshing, schedule another pass.
  const restageRef = useRef<Set<Slice>>(new Set());
  // Sandboxed slices (projects, custom columns) whose refresh arrived during
  // What-If mode. Refreshed once What-If exits — see WHAT_IF_SANDBOXED_SLICES.
  const deferredWhatIfRef = useRef<Set<Slice>>(new Set());

  const runRefresh = useCallback(async () => {
    if (inFlightRef.current) return;
    const slices = pendingSlicesRef.current;
    if (slices.size === 0) return;

    inFlightRef.current = true;
    pendingSlicesRef.current = new Set();

    // Never replace the What-If sandbox with server state: defer those slices.
    const whatIfActive = useWhatIfStore.getState().whatIfMode;
    const batch: Slice[] = [];
    for (const slice of slices) {
      if (whatIfActive && WHAT_IF_SANDBOXED_SLICES.has(slice)) {
        deferredWhatIfRef.current.add(slice);
      } else {
        batch.push(slice);
      }
    }

    if (batch.length > 0) {
      console.info('[WS] refreshing slices', batch);
    }
    if (whatIfActive && deferredWhatIfRef.current.size > 0) {
      console.info('[WS] What-If active, deferring', Array.from(deferredWhatIfRef.current));
    }

    const tasks: Array<Promise<unknown>> = [];
    for (const slice of batch) {
      switch (slice) {
        case 'projects':
          tasks.push(loadAllProjects().then(setProjects).catch((e) => console.error('[WS] projects refresh failed', e)));
          break;
        case 'staff':
          tasks.push(getStaff(true).then(setStaff).catch((e) => console.error('[WS] staff refresh failed', e)));
          break;
        // View-gated (views.equipment): empty without the key or on a 403
        case 'equipment':
          tasks.push(
            loadGated('views.equipment', () => getEquipment(true))
              .then(setEquipment)
              .catch((e) => console.error('[WS] equipment refresh failed', e))
          );
          break;
        case 'equipmentBlocks':
          tasks.push(
            loadGated('views.equipment', () => getEquipmentBlocks())
              .then(setEquipmentBlocks)
              .catch((e) => console.error('[WS] equipment blocks refresh failed', e))
          );
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
        case 'projectFields':
          tasks.push(
            projectFieldsApi.getAll()
              .then(setProjectFields)
              .catch((e) => console.error('[WS] project fields refresh failed', e))
          );
          break;
        case 'teams':
          tasks.push(teamsApi.getAll().then(setTeams).catch((e) => console.error('[WS] teams refresh failed', e)));
          break;
        case 'roles':
          tasks.push(rolesApi.getAll().then(setRoles).catch((e) => console.error('[WS] roles refresh failed', e)));
          break;
        case 'absenceTypes':
          tasks.push(absenceTypesApi.getAll().then(setAbsenceTypes).catch((e) => console.error('[WS] absence types refresh failed', e)));
          break;
        case 'siteCalendar': {
          // Read the site at refresh time, not render time, and drop the
          // result if the user switched site while it was in flight.
          const siteId = useAppStore.getState().currentSite?.id;
          if (siteId == null) break;
          const isStillCurrent = () => useAppStore.getState().currentSite?.id === siteId;
          tasks.push(
            getBankHolidays(siteId)
              .then((holidays) => {
                if (isStillCurrent()) setBankHolidays(holidays, buildHolidayDateSet(holidays));
              })
              .catch((e) => console.error('[WS] bank holidays refresh failed', e)),
            getCompanyEvents(siteId)
              .then((events) => {
                if (isStillCurrent()) setCompanyEvents(events, buildEventDateSet(events));
              })
              .catch((e) => console.error('[WS] company events refresh failed', e)),
          );
          break;
        }
        case 'customColumns': {
          // Same "still the current site" guard as siteCalendar.
          const siteId = useAppStore.getState().currentSite?.id;
          if (siteId == null) break;
          tasks.push(
            getCustomColumnsWithValues(siteId)
              .then((data) => {
                if (useAppStore.getState().currentSite?.id !== siteId) return;
                const store = useCustomColumnStore.getState();
                store.setCustomColumns(data.columns);
                store.setCustomColumnValues(data.values);
              })
              .catch((e) => console.error('[WS] custom columns refresh failed', e)),
          );
          break;
        }
        case 'settings':
          tasks.push(getInstanceSettings().then(setInstanceSettings).catch((e) => console.error('[WS] settings refresh failed', e)));
          break;
        case 'approvalPolicies':
          // The pending badge's approver names (only once something loaded
          // them). A decision does not change them: only change:approval_policy.
          tasks.push(
            refreshApprovalPoliciesIfLoaded().catch((e) =>
              console.error('[WS] approval policies refresh failed', e)
            )
          );
          break;
        case 'approvals':
          // Both request lists live in workStore, which reloads them together.
          tasks.push(
            useWorkStore
              .getState()
              .refresh()
              .catch((e) => console.error('[WS] approvals refresh failed', e))
          );
          break;
        case 'currentUser':
          tasks.push(
            fetchCurrentUser()
              .then((user) => {
                // null = this session is no longer valid (user deleted/disabled).
                if (user) setCurrentUser(user);
                else expireSession();
              })
              .catch((e) => console.error('[WS] current user refresh failed', e)),
          );
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
  }, [
    setProjects, setStaff, setEquipment, setEquipmentBlocks, setVacations, setSites,
    setSkills, setTags, setProjectFields, setTeams, setRoles, setAbsenceTypes, setBankHolidays, setCompanyEvents,
    setInstanceSettings, setCurrentUser,
  ]);

  // A notification push is a live hint; the bell also reloads on mount/focus,
  // because the connection manager is per-process and cannot reach a user
  // connected to another worker.
  const handleNotificationReceived = useCallback((notification: AppNotification) => {
    useNotificationStore.getState().receive(notification);
  }, []);

  const stageSlices = useCallback((slices: Slice[]) => {
    const target = inFlightRef.current ? restageRef.current : pendingSlicesRef.current;
    for (const slice of slices) {
      target.add(slice);
    }

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    // Short debounce so a burst of drag-related updates collapses into a single
    // refresh, but the receiving user still feels the change near-instantly.
    refreshTimeoutRef.current = window.setTimeout(runRefresh, 200);
  }, [runRefresh]);

  const handleChangeReceived = useCallback((change: ChangePayload) => {
    stageSlices(slicesForEntity(change.entity_type));
  }, [stageSlices]);

  // Per-user push (a request reaches its people): a live hint like
  // notification:new; workStore reloads through the same debounce.
  const handleApprovalChanged = useCallback(() => stageSlices(['approvals']), [stageSlices]);

  // The server closed the socket for an invalid / revoked session (4001), a
  // disabled user or a disallowed Origin (both 4003). Confirm with
  // GET /api/auth/me before logging out: only a definite "no user" ends the
  // session; a network error or a still-valid session (Origin case) leaves it.
  // Resolves to true when the session is still valid, so the socket retries
  // once instead of staying offline for the tab's lifetime.
  const handleSessionInvalid = useCallback((): Promise<boolean> => {
    return fetchCurrentUser()
      .then((user) => {
        if (!user) {
          expireSession();
          return false;
        }
        return true;
      })
      .catch((e) => {
        console.warn('[WS] session check failed', e);
        return false;
      });
  }, []);
  
  const {
    connectionState,
    offline,
    onlineUsers,
    recentChanges,
    connect,
    disconnect,
  } = useWebSocket({
    autoConnect: true,
    onChangeReceived: handleChangeReceived,
    onNotificationReceived: handleNotificationReceived,
    onApprovalChanged: handleApprovalChanged,
    onSessionInvalid: handleSessionInvalid,
  });

  // workStore feeds the sidebar's My Work badge, so it loads with the
  // signed-in app (this provider) and again on window focus: the pushes and
  // slices above are hints that a user on another worker misses.
  useEffect(() => {
    const refreshWork = () => {
      useWorkStore
        .getState()
        .refresh()
        .catch((e) => console.error('[WS] approvals refresh failed', e));
    };
    refreshWork();
    window.addEventListener('focus', refreshWork);
    return () => window.removeEventListener('focus', refreshWork);
  }, []);

  // When What-If mode exits, run the refreshes that were deferred during it.
  useEffect(() => {
    return useWhatIfStore.subscribe((state, prev) => {
      if (!prev.whatIfMode || state.whatIfMode) return;
      const deferred = deferredWhatIfRef.current;
      if (deferred.size === 0) return;
      deferredWhatIfRef.current = new Set();
      const target = inFlightRef.current ? restageRef.current : pendingSlicesRef.current;
      for (const slice of deferred) target.add(slice);
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
      refreshTimeoutRef.current = window.setTimeout(runRefresh, 200);
    });
  }, [runRefresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const isConnected = connectionState === 'connected';

  const reconnect = useCallback(() => {
    disconnect();
    setTimeout(connect, 100);
  }, [connect, disconnect]);

  const value = useMemo<WebSocketContextValue>(
    () => ({
      connectionState,
      isConnected,
      offline,
      onlineUsers,
      recentChanges,
      reconnect,
    }),
    [
      connectionState,
      isConnected,
      offline,
      onlineUsers,
      recentChanges,
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
