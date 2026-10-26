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
import type { AppNotification } from '@/types';

// Feature flag to disable WebSocket (set to true to disable until proxy/IIS is properly configured).
// Guards live inside the effect/callback bodies so hook order stays unconditional.
const WEBSOCKET_DISABLED: boolean = false;

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

/** The payload of a per-user push (`approval:changed`): a hint, refetch for the state. */
export interface UserEventPayload {
  id?: number;
  action?: string;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  /** Called when online users list changes */
  onPresenceChange?: (users: PresenceUser[]) => void;
  /** Called when another user makes a change */
  onChangeReceived?: (change: ChangePayload) => void;
  /** Called when a notification addressed to this user arrives */
  onNotificationReceived?: (notification: AppNotification) => void;
  /** Called when an approval request of or for this user changed (`approval:changed`) */
  onApprovalChanged?: (payload: UserEventPayload) => void;
  /**
   * Called when the server closed the socket because the session may not be
   * valid any more: 4001 (no / invalid / expired / revoked session) or 4003
   * (user disabled, or Origin not allowed — the caller confirms with
   * GET /auth/me before logging out). The socket does not reconnect after
   * these on its own. Return (or resolve to) `true` when the session turned
   * out to be still valid: the hook then retries the connection once, with a
   * fresh backoff budget (a handshake cookie race heals; a repeated 4001/4003
   * on that retry stays terminal).
   */
  onSessionInvalid?: (code: number) => Promise<boolean> | boolean | void;
  /** Enable auto-connect (default: true) */
  autoConnect?: boolean;
}

interface UseWebSocketReturn {
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether currently connected */
  isConnected: boolean;
  /**
   * Live sync is not working: the browser is offline, or the socket dropped
   * (or never came up) and is not connected right now — retrying, or given up
   * until the tab becomes visible again / the network comes back. False while
   * the first connection attempt is still pending.
   */
  offline: boolean;
  /** List of online users */
  onlineUsers: PresenceUser[];
  /** Recent changes from other users (last 30 seconds) */
  recentChanges: ChangePayload[];
  /** Manually connect */
  connect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
}

// Constants
const RECONNECT_BASE_DELAY = 2000;  // 2 seconds (was 1)
const RECONNECT_MAX_DELAY = 60000;  // 60 seconds (was 30)
const RECONNECT_MAX_ATTEMPTS = 5;   // Stop after 5 attempts (until `online` / tab visible again)
const PING_INTERVAL = 25000;        // 25 seconds
// How long the inline "changed by X" badge stays glued to a phase/subphase/etc.
// Long enough that a user can scroll/look around and still see who just edited.
const CHANGE_EXPIRY = 30000;

// Close codes after which the socket never reconnects on its own.
const NO_RECONNECT_CODES = [1000, 1001, 4000, 4001, 4002, 4003, 4004, 4005, 4006];
// Of those, the ones that will fail again until something changes server-side
// or the user signs in again; `online` / visibility do not retry them.
const TERMINAL_CODES = [4000, 4001, 4002, 4003, 4004, 4005, 4006];
// The session may be gone: 4001 (no / invalid / expired / revoked session),
// 4003 (user disabled, or Origin not allowed). The caller confirms via
// GET /auth/me, so an Origin rejection does not log a valid session out.
const SESSION_INVALID_CODES = [4001, 4003];

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

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
    onNotificationReceived,
    onApprovalChanged,
    onSessionInvalid,
    autoConnect = true,
  } = options;

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [recentChanges, setRecentChanges] = useState<ChangePayload[]>([]);
  const [browserOffline, setBrowserOffline] = useState(browserIsOffline);
  // Set once the first connection attempt has settled (opened or closed), so
  // `offline` does not flash during the initial connect.
  const [hasSettled, setHasSettled] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  // Mirror of onlineUsers for computing presence updates outside of state
  // updaters (updaters must stay pure: StrictMode runs them twice).
  const onlineUsersRef = useRef<PresenceUser[]>([]);
  // Close code of the last closed socket, null while none closed yet.
  const lastCloseCodeRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  // The one retry after a 4001/4003 whose session was confirmed valid has
  // been spent; re-armed once a socket gets a message (i.e. authenticated).
  const sessionRetryUsedRef = useRef(false);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);  // Lock to prevent multiple connection attempts
  
  // Store callbacks in refs to avoid reconnection loops when they change
  const onPresenceChangeRef = useRef(onPresenceChange);
  const onChangeReceivedRef = useRef(onChangeReceived);
  const onNotificationReceivedRef = useRef(onNotificationReceived);
  const onApprovalChangedRef = useRef(onApprovalChanged);
  const onSessionInvalidRef = useRef(onSessionInvalid);
  
  // Keep refs updated
  useEffect(() => {
    onPresenceChangeRef.current = onPresenceChange;
  }, [onPresenceChange]);
  
  useEffect(() => {
    onChangeReceivedRef.current = onChangeReceived;
  }, [onChangeReceived]);

  useEffect(() => {
    onNotificationReceivedRef.current = onNotificationReceived;
  }, [onNotificationReceived]);

  useEffect(() => {
    onApprovalChangedRef.current = onApprovalChanged;
  }, [onApprovalChanged]);

  useEffect(() => {
    onSessionInvalidRef.current = onSessionInvalid;
  }, [onSessionInvalid]);

  const updateOnlineUsers = useCallback((users: PresenceUser[], notify: boolean) => {
    onlineUsersRef.current = users;
    setOnlineUsers(users);
    if (notify) onPresenceChangeRef.current?.(users);
  }, []);

  // Clear expired changes. We expire based on local receipt time, not the
  // server timestamp, so clock skew between client and server can't drop
  // every change as "already expired."
  useEffect(() => {
    if (WEBSOCKET_DISABLED) return;
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
          updateOnlineUsers(listPayload.users, true);
          break;
        }

        // The callback runs here, once, not inside a setState updater.
        case 'presence:join': {
          const joinUser = message.payload as PresenceUser;
          const filtered = onlineUsersRef.current.filter(u => u.user_id !== joinUser.user_id);
          updateOnlineUsers([...filtered, joinUser], true);
          break;
        }

        case 'presence:leave': {
          const leavePayload = message.payload as { user_id: number };
          updateOnlineUsers(
            onlineUsersRef.current.filter(u => u.user_id !== leavePayload.user_id),
            true
          );
          break;
        }

        case 'notification:new': {
          // NOT handled by the default branch below, which only recognises
          // "change:*" -- without this case the push is silently dropped.
          onNotificationReceivedRef.current?.(message.payload as AppNotification);
          break;
        }

        // Per-user push, like notification:new: not "change:*", so the
        // default branch would drop it.
        case 'approval:changed': {
          onApprovalChangedRef.current?.((message.payload ?? {}) as UserEventPayload);
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
  }, [updateOnlineUsers]); // Stable; everything else goes through refs

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (WEBSOCKET_DISABLED) return;
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
        setHasSettled(true);
        reconnectAttemptRef.current = 0;
        lastCloseCodeRef.current = null;
        console.info('[WS] connected', url);

        // Start ping interval
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };
      
      ws.onmessage = (event: MessageEvent) => {
        // The server only sends to authenticated connections (presence:list
        // first), so this socket got past the session check.
        sessionRetryUsedRef.current = false;
        handleMessage(event);
      };
      
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
        setHasSettled(true);
        updateOnlineUsers([], false);
        lastCloseCodeRef.current = event.code;

        if (SESSION_INVALID_CODES.includes(event.code)) {
          const verdict = onSessionInvalidRef.current?.(event.code);
          if (!sessionRetryUsedRef.current) {
            const closeCode = event.code;
            Promise.resolve(verdict)
              .then((stillValid) => {
                if (stillValid !== true || !mountedRef.current) return;
                // Something else reconnected meanwhile, or this close is stale.
                if (wsRef.current !== ws || lastCloseCodeRef.current !== closeCode) return;
                sessionRetryUsedRef.current = true;
                lastCloseCodeRef.current = null;
                reconnectAttemptRef.current = 0;
                if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = window.setTimeout(() => {
                  reconnectTimeoutRef.current = null;
                  if (mountedRef.current) connect();
                }, RECONNECT_BASE_DELAY);
              })
              .catch(() => {});
          }
        }
        
        // Don't reconnect if:
        // - closed normally (1000)
        // - going away (1001) - browser navigating away
        // - replaced by new connection (4000) 
        // - no / invalid / revoked session (4001)
        // - auth error (4002)
        // - user disabled or Origin not allowed (4003)
        // - component unmounted
        if (NO_RECONNECT_CODES.includes(event.code) || !mountedRef.current) {
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
  }, [handleMessage, updateOnlineUsers]);

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
    updateOnlineUsers([], false);
  }, [updateOnlineUsers]);

  // Store connect in a ref to avoid re-running the effect
  const connectRef = useRef(connect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Auto-connect on mount (only once)
  useEffect(() => {
    if (WEBSOCKET_DISABLED) return;
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

  // Come back after the backoff gave up (a deploy longer than ~1 min, a
  // laptop sleep, a network switch): retry with a fresh attempt budget when
  // the network returns or the tab becomes visible again.
  useEffect(() => {
    if (WEBSOCKET_DISABLED || !autoConnect) return;

    const retryNow = () => {
      if (!mountedRef.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      // Auth/tenant failures would only fail again.
      if (lastCloseCodeRef.current !== null && TERMINAL_CODES.includes(lastCloseCodeRef.current)) {
        return;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      connectRef.current();
    };

    const handleOnline = () => {
      setBrowserOffline(false);
      retryNow();
    };
    const handleOffline = () => setBrowserOffline(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') retryNow();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [autoConnect]);

  const offline =
    browserOffline ||
    (hasSettled && connectionState !== 'connected' && connectionState !== 'connecting');

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    offline,
    onlineUsers,
    recentChanges,
    connect,
    disconnect,
  };
}
