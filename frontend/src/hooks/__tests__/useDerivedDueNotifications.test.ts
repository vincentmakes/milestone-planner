/**
 * Due-soon / overdue reminders derived client-side from the current user's
 * Kanban cards, with per-due-date dismissals in localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDerivedDueNotifications, dismissDerivedNotification } from '../useDerivedDueNotifications';
import { resetAllStores, useAppStore } from '@/stores';
import { formatDateISO } from '@/utils/date';
import { STORAGE_KEYS } from '@/utils/storage';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';

beforeEach(() => {
  resetAllStores();
  localStorage.clear();
});

describe('useDerivedDueNotifications', () => {
  function iso(offset: number) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return formatDateISO(d);
  }
  const mine = [{ id: 1, staff_id: 4, allocation: 50, start_date: '', end_date: '' }];

  function seed() {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user' }),
      projects: [
        makeProject({
          id: 1,
          name: 'Bioprocess Scale-Up',
          phases: [
            makePhase({ id: 10, name: 'Late phase', end_date: iso(-2), staffAssignments: mine }),
            makePhase({
              id: 11,
              name: 'Parent',
              end_date: iso(30),
              children: [
                makeSubphase({ id: 20, name: 'Soon task', end_date: iso(3), staffAssignments: mine }),
                makeSubphase({ id: 21, name: 'Far task', end_date: iso(40), staffAssignments: mine }),
                makeSubphase({ id: 22, name: 'Done task', end_date: iso(-5), status: 'done', staffAssignments: mine }),
                makeSubphase({ id: 23, name: 'Someone else', end_date: iso(1) }),
              ],
            }),
          ],
        }),
      ],
    });
  }

  it('lists overdue and due-soon cards assigned to me, with negative ids', () => {
    seed();
    const { result } = renderHook(() => useDerivedDueNotifications());
    expect(result.current.map((n) => [n.id, n.type, n.title])).toEqual([
      [-1, 'overdue', 'Late phase is overdue'],
      [-2, 'due_soon', 'Soon task is due soon'],
    ]);
    expect(result.current[1]).toMatchObject({
      entity_type: 'subphase',
      entity_id: 20,
      project_id: 1,
      body: `Bioprocess Scale-Up - due ${iso(3)}`,
      source: 'derived',
      read_at: null,
    });
  });

  it('sends no reminder for a card my booking on is still awaiting approval', () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user' }),
      projects: [
        makeProject({
          id: 1,
          phases: [
            makePhase({
              id: 10,
              name: 'Requested',
              end_date: iso(-2),
              staffAssignments: [{ ...mine[0], approval_status: 'pending' }],
            }),
          ],
        }),
      ],
    });
    const { result } = renderHook(() => useDerivedDueNotifications());
    expect(result.current).toEqual([]);
  });

  it('forgets a dismissed reminder until the due date changes', () => {
    seed();
    dismissDerivedNotification('phase-10', iso(-2));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.KANBAN_DUE_DISMISSED)!)).toHaveProperty(`phase-10@${iso(-2)}`);
    const { result, rerender } = renderHook(() => useDerivedDueNotifications());
    expect(result.current.map((n) => n.title)).toEqual(['Soon task is due soon']);

    // rescheduled, still overdue: notifies afresh
    const projects = structuredClone(useAppStore.getState().projects);
    projects[0].phases[0].end_date = iso(-1);
    act(() => useAppStore.setState({ projects }));
    rerender();
    expect(result.current.map((n) => n.title)).toContain('Late phase is overdue');
  });

  it('drops a reminder as soon as it is dismissed, in every mounted user of the hook', () => {
    seed();
    const first = renderHook(() => useDerivedDueNotifications());
    const second = renderHook(() => useDerivedDueNotifications());
    expect(first.result.current).toHaveLength(2);

    act(() => dismissDerivedNotification('subphase-20', iso(3)));

    expect(first.result.current.map((n) => n.title)).toEqual(['Late phase is overdue']);
    expect(second.result.current.map((n) => n.title)).toEqual(['Late phase is overdue']);
  });

  it('is empty when nobody is signed in', () => {
    seed();
    useAppStore.setState({ currentUser: null });
    const { result } = renderHook(() => useDerivedDueNotifications());
    expect(result.current).toEqual([]);
  });
});
