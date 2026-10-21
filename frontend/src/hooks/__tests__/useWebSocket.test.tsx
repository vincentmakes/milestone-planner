/**
 * useWebSocket: reconnects when the network or the tab comes back after the
 * backoff gave up (F1-14), exposes an `offline` flag, reports invalid-session
 * closes (F1-13), and runs the presence callback once per message even under
 * StrictMode (F1-21).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from '../useWebSocket';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    this.serverClose(code, reason);
  }

  // --- test helpers ---
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  message(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload, timestamp: '2026-01-01T00:00:00Z' }) });
  }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconnects with a fresh attempt budget when the tab becomes visible after giving up', async () => {
    const { result } = renderHook(() => useWebSocket());
    await flush(150);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => latest().open());
    expect(result.current.offline).toBe(false);

    // Server goes away for good: 1 initial drop + 5 failed retries.
    act(() => latest().serverClose(1006));
    for (let i = 0; i < 5; i++) {
      await flush(70_000);
      act(() => latest().serverClose(1006));
    }
    await flush(120_000);
    const afterGivingUp = FakeWebSocket.instances.length;
    expect(afterGivingUp).toBe(6);
    expect(result.current.offline).toBe(true);

    // Tab comes back to the foreground: try again immediately.
    act(() => setVisibility('visible'));
    expect(FakeWebSocket.instances).toHaveLength(afterGivingUp + 1);
    act(() => latest().open());
    expect(result.current.isConnected).toBe(true);
    expect(result.current.offline).toBe(false);
  });

  it('reconnects on the browser `online` event and tracks `offline`', async () => {
    const { result } = renderHook(() => useWebSocket());
    await flush(150);
    act(() => latest().open());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.offline).toBe(true);

    act(() => latest().serverClose(1006));
    const before = FakeWebSocket.instances.length;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // Retried right away, without waiting for the 2 s backoff.
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
    act(() => latest().open());
    expect(result.current.offline).toBe(false);
  });

  it('does not report offline while the first connection is still pending', async () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.offline).toBe(false);
    await flush(150);
    expect(result.current.offline).toBe(false);
  });

  it('reports an invalid session (4001) and does not retry it on visibility', async () => {
    const onSessionInvalid = vi.fn();
    renderHook(() => useWebSocket({ onSessionInvalid }));
    await flush(150);
    act(() => latest().open());

    act(() => latest().serverClose(4001, 'Invalid or expired session'));
    expect(onSessionInvalid).toHaveBeenCalledWith(4001);

    const count = FakeWebSocket.instances.length;
    act(() => setVisibility('visible'));
    await flush(10_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it('reports a disabled user (4003) but not a normal close', async () => {
    const onSessionInvalid = vi.fn();
    renderHook(() => useWebSocket({ onSessionInvalid }));
    await flush(150);
    act(() => latest().open());
    act(() => latest().serverClose(1006));
    expect(onSessionInvalid).not.toHaveBeenCalled();

    await flush(2_500);
    act(() => latest().open());
    act(() => latest().serverClose(4003));
    expect(onSessionInvalid).toHaveBeenCalledWith(4003);
  });

  it('never retries an Origin rejection (4003), not even on online / visibility', async () => {
    renderHook(() => useWebSocket());
    await flush(150);
    act(() => latest().open());
    act(() => latest().serverClose(4003, 'Origin not allowed'));

    const count = FakeWebSocket.instances.length;
    await flush(65_000);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    act(() => setVisibility('visible'));
    await flush(10_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it('retries once after a 4001/4003 when the session is confirmed valid, then stays terminal', async () => {
    const onSessionInvalid = vi.fn(async () => true);
    const { result } = renderHook(() => useWebSocket({ onSessionInvalid }));
    await flush(150);
    act(() => latest().open());
    act(() => latest().serverClose(4003, 'Origin not allowed'));
    expect(onSessionInvalid).toHaveBeenCalledWith(4003);
    expect(result.current.offline).toBe(true);

    // One retry after the base backoff delay, not before.
    const count = FakeWebSocket.instances.length;
    await flush(1_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
    await flush(1_500);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);

    // The retry is rejected the same way: no further attempts, even on
    // online / visibility.
    act(() => latest().open());
    act(() => latest().serverClose(4003, 'Origin not allowed'));
    await flush(65_000);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    act(() => setVisibility('visible'));
    await flush(10_000);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
    expect(result.current.offline).toBe(true);
  });

  it('clears the offline state when the retry after a valid-session 4001 connects', async () => {
    const onSessionInvalid = vi.fn(async () => true);
    const { result } = renderHook(() => useWebSocket({ onSessionInvalid }));
    await flush(150);
    act(() => latest().open());
    act(() => latest().serverClose(4001, 'No session cookie'));
    expect(result.current.offline).toBe(true);

    await flush(2_500);
    act(() => latest().open());
    act(() => latest().message('presence:list', { users: [] }));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.offline).toBe(false);

    // An authenticated connection re-arms the one retry for a later 4001.
    const count = FakeWebSocket.instances.length;
    act(() => latest().serverClose(4001, 'No session cookie'));
    await flush(2_500);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
  });

  it('does not retry a 4001 when the session check says the session is gone', async () => {
    const onSessionInvalid = vi.fn(async () => false);
    renderHook(() => useWebSocket({ onSessionInvalid }));
    await flush(150);
    act(() => latest().open());
    act(() => latest().serverClose(4001));
    const count = FakeWebSocket.instances.length;
    await flush(65_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it('hands the per-user todo:changed / approval:changed pushes to their callbacks', async () => {
    const onTodoChanged = vi.fn();
    const onApprovalChanged = vi.fn();
    const onChangeReceived = vi.fn();
    renderHook(() => useWebSocket({ onTodoChanged, onApprovalChanged, onChangeReceived }));
    await flush(150);
    act(() => latest().open());

    act(() => latest().message('todo:changed', { id: 3, kind: 'task', action: 'update' }));
    act(() => latest().message('approval:changed', { id: 31, action: 'approve' }));
    act(() => latest().message('todo:changed', null));

    expect(onTodoChanged).toHaveBeenCalledTimes(2);
    expect(onTodoChanged).toHaveBeenNthCalledWith(1, { id: 3, kind: 'task', action: 'update' });
    expect(onTodoChanged).toHaveBeenNthCalledWith(2, {});
    expect(onApprovalChanged).toHaveBeenCalledWith({ id: 31, action: 'approve' });
    expect(onChangeReceived).not.toHaveBeenCalled();
  });

  it('calls onPresenceChange once per presence message under StrictMode', async () => {
    const onPresenceChange = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useWebSocket({ onPresenceChange }), { wrapper });
    await flush(150);
    act(() => latest().open());

    const alice = { user_id: 1, first_name: 'Alice', last_name: 'A', connected_at: '' };
    const bob = { user_id: 2, first_name: 'Bob', last_name: 'B', connected_at: '' };
    act(() => latest().message('presence:join', alice));
    act(() => latest().message('presence:join', bob));
    act(() => latest().message('presence:leave', { user_id: 1 }));

    expect(onPresenceChange).toHaveBeenCalledTimes(3);
    expect(onPresenceChange.mock.calls[1][0].map((u: { user_id: number }) => u.user_id)).toEqual([1, 2]);
    expect(onPresenceChange.mock.calls[2][0].map((u: { user_id: number }) => u.user_id)).toEqual([2]);
    expect(result.current.onlineUsers.map((u) => u.user_id)).toEqual([2]);
  });
});
