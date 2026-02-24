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
const WEBSOCKET_DISABLED = true;

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
  entity_type: 'phase' | 'subphase' | 'project' | 'assignment';
  entity_id: number;
  project_id: number;
  action: 'create' | 'update' | 'delete' | 'move';
  summary?: string;
  timestamp?: string;  // Added when received
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
const CHANGE_EXPIRY = 5000;         // Show changes for 5 seconds

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

  // Clear expired changes
  useEffect(() => {
    const interval = setInterval(() => {
      setRecentChanges(prev => {
        const now = Date.now();
        return prev.filter(c => {
          const changeTime = new Date(c.timestamp || '').getTime();
          return now - changeTime < CHANGE_EXPIRY;
        });
      });
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  // Handle incoming messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: ServerMessage = JSON.parse(event.data);
      console.log('[WebSocket] Received:', message.type, message.payload);
      
      switch (message.type) {
        case 'pong':
          // Keepalive acknowledged
          break;
          
        case 'presence:list':
          const listPayload = message.payload as { users: PresenceUser[] };
          console.log('[WebSocket] Presence list:', listPayload.users);
          setOnlineUsers(listPayload.users);
          onPresenceChangeRef.current?.(listPayload.users);
          break;
          
        case 'presence:join':
          const joinUser = message.payload as PresenceUser;
          console.log('[WebSocket] User joined:', joinUser);
          setOnlineUsers(prev => {
            // Avoid duplicates
            const filtered = prev.filter(u => u.user_id !== joinUser.user_id);
            const updated = [...filtered, joinUser];
            onPresenceChangeRef.current?.(updated);
            return updated;
          });
          break;
          
        case 'presence:leave':
          const leavePayload = message.payload as { user_id: number };
          console.log('[WebSocket] User left:', leavePayload.user_id);
          setOnlineUsers(prev => {
            const updated = prev.filter(u => u.user_id !== leavePayload.user_id);
            onPresenceChangeRef.current?.(updated);
            return updated;
          });
          break;
          
        case 'change:phase':
        case 'change:subphase':
        case 'change:project':
        case 'change:assignment':
          const change = message.payload as ChangePayload;
          console.log('[WebSocket] Change received:', change);
          // Add timestamp for expiry tracking
          change.timestamp = message.timestamp;
          setRecentChanges(prev => [...prev, change]);
          onChangeReceivedRef.current?.(change);
          break;
          
        default:
          console.log('[WebSocket] Unknown message type:', message.type);
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
        console.log('[WebSocket] Already connected or connecting, skipping');
        return;
      }
    }
    
    // Use a lock to prevent multiple simultaneous connection attempts
    if (connectingRef.current) {
      console.log('[WebSocket] Connection already in progress, skipping');
      return;
    }
    connectingRef.current = true;

    const url = getWebSocketUrl();
    console.log('[WebSocket] Connecting to:', url);
    setConnectionState('connecting');
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      
      ws.onopen = () => {
        connectingRef.current = false;
        if (!mountedRef.current) return;
        console.log('[WebSocket] Connected successfully');
        setConnectionState('connected');
        reconnectAttemptRef.current = 0;
        
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
        
        console.log(`[WebSocket] Connection closed: code=${event.code}, reason=${event.reason}`);
        
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
          console.log(`[WebSocket] Closed with code ${event.code}, not reconnecting`);
          return;
        }
        
        // Stop after max attempts
        if (reconnectAttemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
          console.log(`[WebSocket] Max reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up`);
          return;
        }
        
        // Exponential backoff reconnect
        const delay = Math.min(
          RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
          RECONNECT_MAX_DELAY
        );
        reconnectAttemptRef.current++;
        
        console.log(`[WebSocket] Closed with code ${event.code}, reconnecting in ${delay}ms...`);
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
