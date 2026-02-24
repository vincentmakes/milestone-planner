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

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const setProjects = useAppStore((s) => s.setProjects);
  
  // Debounce refresh to avoid multiple rapid requests
  const refreshTimeoutRef = useRef<number | null>(null);
  const pendingRefreshRef = useRef(false);
  
  // Refresh projects data from server
  const refreshProjects = useCallback(async () => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = true;
    
    try {
      console.log('[WebSocket] Refreshing projects due to remote change...');
      const projects = await loadAllProjects();
      setProjects(projects);
      console.log('[WebSocket] Projects refreshed:', projects.length);
    } catch (err) {
      console.error('[WebSocket] Failed to refresh projects:', err);
    } finally {
      pendingRefreshRef.current = false;
    }
  }, [setProjects]);
  
  // Handle incoming changes - debounced refresh
  const handleChangeReceived = useCallback((change: ChangePayload) => {
    console.log('[WebSocket] Change received, scheduling refresh:', change.entity_type, change.entity_id);
    
    // Clear any pending refresh
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    
    // Debounce: wait 500ms before refreshing (in case multiple changes come quickly)
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshProjects();
    }, 500);
  }, [refreshProjects]);
  
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

/**
 * Hook to check if entity was recently changed
 */
export function useEntityChangeIndicator(entityType: string, entityId: number): {
  isChanged: boolean;
  changedBy: string | null;
} {
  const { recentChanges } = useWebSocketContext();
  
  const change = recentChanges.find(
    c => c.entity_type === entityType && c.entity_id === entityId
  );
  
  return {
    isChanged: !!change,
    changedBy: change?.user_name ?? null,
  };
}
