/**
 * useWebSocket Hook
 * 
 * Manages WebSocket connection for real-time collaboration.
 * Handles:
 * - Auto-connect when authenticated
 * - Reconnection with exponential backoff
 * - Ping/pong keepalive
 * - Message dispatching
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getTenantPrefix } from '@/api/client';

// Feature flag to disable WebSocket (set to true to disable until proxy/IIS is properly configured)
const WEBSOCKET_DISABLED = false;

// Message types from server
export interface PresenceUser {
  user_id: number;
  first_name: string;
  last_name: string;
  connected_at: string;
}

export interface ChangePayload {
  user_id: number;
  user_name: string;
  /**
   * Type of entity that changed. Common values include:
   * phase, subphase, project, assignment, staff, equipment, equipment_block,
   * vacation, skill, site, custom_column, note, tag, user, predefined_phase,
   * settings, bank_holiday, company_event.
   */
  entity_type: string;
  entity_id: number;
  /** Parent project id (0 when the entity isn't tied to a single project). */
  project_id: number;
  action: 'create' | 'update' | 'delete' | 'move';
  summary?: string;
  timestamp?: string;  // Server-supplied ISO string (added when received)
  /** Local client-side receipt time, used for expiry to avoid clock-skew bugs. */
  _receivedAt?: number;
}

export interface ServerMessage {
  type: string;
  payload: unknown;
  timestamp: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseWebSocketOptions {
  /** Called when online users list changes */
  onPresenceChange?: (users: PresenceUser[]) => void;
  /** Called when another user makes a change */
  onChangeReceived?: (change: ChangePayload) => void;
  /** Enable auto-connect (default: true) */
  autoConnect?: boolean;
}

interface UseWebSocketReturn {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether currently connected */
  isConnected: boolean;
  /** List of online users */
  onlineUsers: PresenceUser[];
  /** Recent changes from other users (last 30 seconds) */
  recentChanges: ChangePayload[];
  /** Manually connect */
  connect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
  /** Check if an entity was recently changed */
  isChangeRecent: (entityType: string, entityId: number) => boolean;
  /** Get change info for an entity */
  getChangeInfo: (entityType: string, entityId: number) => ChangePayload | undefined;
}

// Constants
const RECONNECT_BASE_DELAY = 2000;  // 2 seconds (was 1)
const RECONNECT_MAX_DELAY = 60000;  // 60 seconds (was 30)
const RECONNECT_MAX_ATTEMPTS = 5;   // Stop after 5 attempts
const PING_INTERVAL = 25000;        // 25 seconds
// How long the inline "changed by X" badge stays glued to a phase/subphase/etc.
// Long enough that a user can scroll/look around and still see who just edited.
const CHANGE_EXPIRY = 30000;

/**
 * Build WebSocket URL based on current location
 */
function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const tenantPrefix = getTenantPrefix();
  
  // In development, connect to backend port
  const wsHost = window.location.port === '3333' 
    ? `${window.location.hostname}:8485`
    : host;
  
  return `${protocol}//${wsHost}${tenantPrefix}/ws`;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { 
    onPresenceChange, 
    onChangeReceived,
    autoConnect = true,
  } = options;

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [recentChanges, setRecentChanges] = useState<ChangePayload[]>([]);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);  // Lock to prevent multiple connection attempts
  
  // Store callbacks in refs to avoid reconnection loops when they change
  const onPresenceChangeRef = useRef(onPresenceChange);
  const onChangeReceivedRef = useRef(onChangeReceived);
  
  // Keep refs updated
  useEffect(() => {
    onPresenceChangeRef.current = onPresenceChange;
  }, [onPresenceChange]);
  
  useEffect(() => {
    onChangeReceivedRef.current = onChangeReceived;
  }, [onChangeReceived]);

  // If WebSocket is disabled, return stub functions
  if (WEBSOCKET_DISABLED) {
    return {
      connectionState: 'disconnected',
      isConnected: false,
      onlineUsers: [],
      recentChanges: [],
      connect: () => {},
      disconnect: () => {},
      isChangeRecent: () => false,
      getChangeInfo: () => undefined,
    };
  }

  // Clear expired changes. We expire based on local receipt time, not the
  // server timestamp, so clock skew between client and server can't drop
  // every change as "already expired."
  useEffect(() => {
    const interval = setInterval(() => {
      setRecentChanges(prev => {
        const now = Date.now();
        return prev.filter(c => {
          const t = c._receivedAt ?? (Date.parse(c.timestamp || '') || now);
          return now - t < CHANGE_EXPIRY;
        });
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Handle incoming messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: ServerMessage = JSON.parse(event.data);
      // Diagnostic: log every incoming WebSocket message so it's easy to
      // tell whether the post-handshake receive channel is alive at all
      // (presence:list, presence:join, change:*, etc).
      if (message.type !== 'pong') {
        console.info('[WS] received', message.type, message.payload);
      }
      switch (message.type) {
        case 'pong':
          // Keepalive acknowledged
          break;

        case 'presence:list': {
          const listPayload = message.payload as { users: PresenceUser[] };
          setOnlineUsers(listPayload.users);
          onPresenceChangeRef.current?.(listPayload.users);
          break;
        }

        case 'presence:join': {
          const joinUser = message.payload as PresenceUser;
          setOnlineUsers(prev => {
            const filtered = prev.filter(u => u.user_id !== joinUser.user_id);
            const updated = [...filtered, joinUser];
            onPresenceChangeRef.current?.(updated);
            return updated;
          });
          break;
        }

        case 'presence:leave': {
          const leavePayload = message.payload as { user_id: number };
          setOnlineUsers(prev => {
            const updated = prev.filter(u => u.user_id !== leavePayload.user_id);
            onPresenceChangeRef.current?.(updated);
            return updated;
          });
          break;
        }

        default: {
          // Treat any "change:*" message uniformly so new entity types
          // (staff, equipment, vacation, ...) work without code changes.
          if (typeof message.type === 'string' && message.type.startsWith('change:')) {
            const change = message.payload as ChangePayload;
            change.timestamp = message.timestamp;
            change._receivedAt = Date.now();
            setRecentChanges(prev => [...prev, change]);
            onChangeReceivedRef.current?.(change);
          }
          // Unknown non-change message types are intentionally ignored.
        }
      }
    } catch (error) {
      console.warn('Failed to parse WebSocket message:', error);
    }
  }, []); // No dependencies - uses refs instead

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Don't connect if already connected or connecting
    if (wsRef.current) {
      const state = wsRef.current.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return;
      }
    }
    
    // Use a lock to prevent multiple simultaneous connection attempts
    if (connectingRef.current) {
      return;
    }
    connectingRef.current = true;

    const url = getWebSocketUrl();
    setConnectionState('connecting');
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      
      ws.onopen = () => {
        connectingRef.current = false;
        if (!mountedRef.current) return;
        setConnectionState('connected');
        reconnectAttemptRef.current = 0;
        console.info('[WS] connected', url);

        // Start ping interval
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };
      
      ws.onmessage = handleMessage;
      
      ws.onclose = (event) => {
        connectingRef.current = false;
        if (!mountedRef.current) return;

        console.info('[WS] closed', { code: event.code, reason: event.reason });

        // Clear ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        setConnectionState('disconnected');
        setOnlineUsers([]);
        
        // Don't reconnect if:
        // - closed normally (1000)
        // - going away (1001) - browser navigating away
        // - replaced by new connection (4000) 
        // - no session (4001)
        // - auth error (4002)
        // - user disabled (4003)
        // - component unmounted
        const noReconnectCodes = [1000, 1001, 4000, 4001, 4002, 4003, 4004, 4005, 4006];
        if (noReconnectCodes.includes(event.code) || !mountedRef.current) {
          return;
        }
        
        // Stop after max attempts
        if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
          return;
        }
        
        // Exponential backoff reconnect
        const delay = Math.min(
          RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
          RECONNECT_MAX_DELAY
        );
        reconnectAttemptRef.current++;
        
        reconnectTimeoutRef.current = window.setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, delay);
      };
      
      ws.onerror = (error) => {
        connectingRef.current = false;
        if (!mountedRef.current) return;
        console.error('[WebSocket] Error:', error);
        setConnectionState('error');
      };
      
    } catch (error) {
      connectingRef.current = false;
      console.error('[WebSocket] Failed to create WebSocket:', error);
      setConnectionState('error');
    }
  }, [handleMessage]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnect');
      wsRef.current = null;
    }
    
    setConnectionState('disconnected');
    setOnlineUsers([]);
  }, []);

  // Store connect in a ref to avoid re-running the effect
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Auto-connect on mount (only once)
  useEffect(() => {
    mountedRef.current = true;
    
    if (autoConnect) {
      // Small delay to ensure cookies are available
      const timeout = setTimeout(() => {
        connectRef.current();
      }, 100);
      return () => clearTimeout(timeout);
    }
  }, [autoConnect]); // Note: connect removed from deps - uses ref instead

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [disconnect]);

  // Helper: check if an entity was recently changed
  const isChangeRecent = useCallback((entityType: string, entityId: number): boolean => {
    return recentChanges.some(c => c.entity_type === entityType && c.entity_id === entityId);
  }, [recentChanges]);

  // Helper: get change info for an entity
  const getChangeInfo = useCallback((entityType: string, entityId: number): ChangePayload | undefined => {
    return recentChanges.find(c => c.entity_type === entityType && c.entity_id === entityId);
  }, [recentChanges]);

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    onlineUsers,
    recentChanges,
    connect,
    disconnect,
    isChangeRecent,
    getChangeInfo,
  };
}
