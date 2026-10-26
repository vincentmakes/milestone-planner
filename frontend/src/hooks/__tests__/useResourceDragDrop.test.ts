/**
 * useResourceDragDrop is the drag *source* only. The drop (assignment create,
 * What-If gate, per-target permission) lives in ResourceDropOverlay; an
 * ungated create path here once sat exported but unused (N-6) and would have
 * bypassed those checks for any future caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useResourceDragDrop } from '../useResourceDragDrop';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';

describe('useResourceDragDrop', () => {
  it('exposes no drop / create path', () => {
    const { result } = renderHook(() => useResourceDragDrop());
    expect(result.current).not.toHaveProperty('handleDrop');
    expect(result.current).not.toHaveProperty('DEFAULT_DURATION_DAYS');
    expect(typeof result.current.handleDragStart).toBe('function');
    expect(typeof result.current.handleDragEnd).toBe('function');
  });
});

describe('useResourceDragDrop self-drag', () => {
  const dragEvent = () =>
    ({ preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } }) as unknown as React.DragEvent;

  beforeEach(() => {
    useAppStore.setState({ projects: [] });
    useUIStore.getState().endResourceDrag();
  });

  it('lets a user book themself when the role allows or needs approval', () => {
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
        approval_required: ['assignments.self_create'],
      }),
    });
    const { result } = renderHook(() => useResourceDragDrop());
    const e = dragEvent();
    result.current.handleDragStart(e, 'staff', 4, 'Bob Brown');
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(useUIStore.getState().resourceDrag.active).toBe(true);
  });

  it('refuses the drag when the role holds no assignments.self_create', () => {
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
      }),
    });
    const { result } = renderHook(() => useResourceDragDrop());
    const e = dragEvent();
    result.current.handleDragStart(e, 'staff', 4, 'Bob Brown');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(useUIStore.getState().resourceDrag.active).toBe(false);
  });
});
