/**
 * Two-click dependency linking (F2-13).
 *
 * - The cycle check walks predecessors from the *source* through phase and
 *   subphase dependencies alike. It used to walk the target's own-kind
 *   predecessors, so a phase <-> subphase cycle (and even the plain reverse
 *   of an existing link) was creatable while harmless shortcuts were refused.
 * - Every new link records the predecessor's kind as `entity`, because phase
 *   and subphase ids are separate sequences.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type React from 'react';
import { useDependencyLinking } from '../useDependencyLinking';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import type { Dependency, Phase, Project, Subphase, User } from '@/types';

const { updatePhase, updateSubphase } = vi.hoisted(() => ({
  updatePhase: vi.fn().mockResolvedValue({}),
  updateSubphase: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/api/endpoints/projects', () => ({
  updatePhase,
  updateSubphase,
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

function subphase(id: number, start: string, end: string, dependencies: Dependency[] = []): Subphase {
  return {
    id,
    name: `Subphase ${id}`,
    start_date: start,
    end_date: end,
    dependencies,
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Subphase;
}

function phase(id: number, start: string, end: string, dependencies: Dependency[] = [], children: Subphase[] = []): Phase {
  return {
    id,
    name: `Phase ${id}`,
    start_date: start,
    end_date: end,
    dependencies,
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Phase;
}

function project(phases: Phase[]): Project {
  return {
    id: 1,
    name: 'P',
    site_id: 1,
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    phases,
  } as unknown as Project;
}

const event = () => ({ stopPropagation() {}, preventDefault() {} }) as unknown as React.MouseEvent;

/** First click on `from`'s end zone, second on `to`'s start zone */
function link(
  from: { id: number; type: 'phase' | 'subphase' },
  to: { id: number; type: 'phase' | 'subphase' }
) {
  const { result, rerender } = renderHook(() => useDependencyLinking());
  act(() => result.current.handleLinkZoneClick(event(), 1, from.id, from.type, 'end'));
  rerender();
  act(() => result.current.handleLinkZoneClick(event(), 1, to.id, to.type, 'start'));
}

let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  updatePhase.mockClear();
  updateSubphase.mockClear();
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  useUIStore.setState({ isLinkingDependency: false, linkingFrom: null });
  useAppStore.setState({ currentUser: { id: 1, role: 'admin' } as unknown as User });
});

afterEach(() => {
  alertSpy.mockRestore();
});

describe('useDependencyLinking cycle check', () => {
  it('refuses a cycle running through a phase and a subphase', () => {
    // Phase 1 already depends on subphase 10 (under phase 2).
    useAppStore.setState({
      projects: [
        project([
          phase(1, '2026-03-11', '2026-03-20', [{ id: 10, type: 'FS', entity: 'subphase' }]),
          phase(2, '2026-03-01', '2026-03-10', [], [subphase(10, '2026-03-01', '2026-03-10')]),
        ]),
      ],
    });

    link({ id: 1, type: 'phase' }, { id: 10, type: 'subphase' });

    expect(alertSpy).toHaveBeenCalledWith('Cannot create circular dependency');
    expect(updateSubphase).not.toHaveBeenCalled();
  });

  it('refuses the reverse of an existing link', () => {
    useAppStore.setState({
      projects: [
        project([
          phase(1, '2026-03-01', '2026-03-10'),
          phase(2, '2026-03-11', '2026-03-20', [{ id: 1, type: 'FS', entity: 'phase' }]),
        ]),
      ],
    });

    link({ id: 2, type: 'phase' }, { id: 1, type: 'phase' });

    expect(alertSpy).toHaveBeenCalledWith('Cannot create circular dependency');
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('allows a transitive shortcut (1 -> 2 -> 3 exists, 1 -> 3 added)', async () => {
    useAppStore.setState({
      projects: [
        project([
          phase(1, '2026-03-01', '2026-03-05'),
          phase(2, '2026-03-06', '2026-03-10', [{ id: 1, type: 'FS', entity: 'phase' }]),
          phase(3, '2026-03-11', '2026-03-15', [{ id: 2, type: 'FS', entity: 'phase' }]),
        ]),
      ],
    });

    link({ id: 1, type: 'phase' }, { id: 3, type: 'phase' });
    await vi.waitFor(() => expect(updatePhase).toHaveBeenCalled());

    expect(alertSpy).not.toHaveBeenCalled();
    expect(updatePhase.mock.calls[0][0]).toBe(3);
  });
});

describe('useDependencyLinking entity field', () => {
  it('records entity: subphase on a link from a subphase whose id a phase shares', async () => {
    useAppStore.setState({
      projects: [
        project([
          phase(5, '2026-03-01', '2026-03-31'),
          phase(6, '2026-03-01', '2026-03-31', [], [
            subphase(5, '2026-03-01', '2026-03-05'),
            subphase(7, '2026-03-10', '2026-03-12'),
          ]),
        ]),
      ],
    });

    link({ id: 5, type: 'subphase' }, { id: 7, type: 'subphase' });
    await vi.waitFor(() => expect(updateSubphase).toHaveBeenCalled());

    const [id, body] = updateSubphase.mock.calls[0];
    expect(id).toBe(7);
    expect(body.dependencies).toEqual([{ id: 5, type: 'FS', entity: 'subphase' }]);
    // FS auto-align used the subphase (ends Mar 5), not phase 5 (ends Mar 31)
    expect(body.start_date).toBe('2026-03-06');
  });

  it('records entity: phase on a link from a phase', async () => {
    useAppStore.setState({
      projects: [
        project([
          phase(1, '2026-03-01', '2026-03-05'),
          phase(2, '2026-03-10', '2026-03-12'),
        ]),
      ],
    });

    link({ id: 1, type: 'phase' }, { id: 2, type: 'phase' });
    await vi.waitFor(() => expect(updatePhase).toHaveBeenCalled());

    expect(updatePhase.mock.calls[0][1].dependencies).toEqual([{ id: 1, type: 'FS', entity: 'phase' }]);
  });
});
