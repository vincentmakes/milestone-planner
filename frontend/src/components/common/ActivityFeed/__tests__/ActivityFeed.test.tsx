/**
 * Live activity toasts from other users' WebSocket change events: wording per
 * entity/action, coalescing of cascaded changes per user + project, filtering
 * to the current site, the 4-toast cap, dismissal and expiry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ActivityFeed } from '../ActivityFeed';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeProject, makeSite } from '@/test/factories';
import type { ChangePayload } from '@/hooks/useWebSocket';

// ActivityFeed is memo()ised with no props, so the mocked context must be a
// subscribable store for a pushed change to re-render it.
let recentChanges: ChangePayload[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getChanges = () => recentChanges;

vi.mock('@/contexts/WebSocketContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useWebSocketContext: () => ({ recentChanges: useSyncExternalStore(subscribe, getChanges) }),
  };
});

let seq = 0;
function change(overrides: Partial<ChangePayload> = {}): ChangePayload {
  seq += 1;
  return {
    user_id: 4,
    user_name: 'Bob Brown',
    entity_type: 'phase',
    entity_id: seq,
    project_id: 1,
    action: 'update',
    summary: 'Feasibility',
    timestamp: `2026-10-16T10:00:${String(seq).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

function setChanges(next: ChangePayload[]) {
  act(() => {
    recentChanges = next;
    listeners.forEach((l) => l());
  });
}

function push(_view: ReturnType<typeof render>, ...changes: ChangePayload[]) {
  setChanges([...recentChanges, ...changes]);
}

const toastTexts = () =>
  Array.from(screen.queryByRole('status')?.children ?? []).map((el) => el.textContent ?? '');

beforeEach(() => {
  vi.useFakeTimers();
  recentChanges = [];
  resetAllStores();
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    projects: [
      makeProject({ id: 1, name: 'Bioprocess Scale-Up', site_id: 1 }),
      makeProject({ id: 2, name: 'Other Site Project', site_id: 2 }),
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityFeed', () => {
  it('renders nothing without changes', () => {
    const view = render(<ActivityFeed />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('describes a change in a project of the current site', () => {
    const view = render(<ActivityFeed />);
    push(view, change());
    expect(toastTexts()).toEqual(['BBBob Brownupdated phase "Feasibility" in Bioprocess Scale-Up']);
    // The dismiss button is the close icon, named by its label.
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each<[Partial<ChangePayload>, string]>([
    [{ entity_type: 'project', action: 'create', summary: 'New R&D' }, 'added project "New R&D"'],
    [{ entity_type: 'project', action: 'delete', summary: '' }, 'deleted project'],
    [{ entity_type: 'tag', action: 'create', project_id: 0, summary: 'Urgent' }, 'added tag "Urgent"'],
    [{ entity_type: 'widget', action: 'move', project_id: 0, summary: undefined }, 'moved widget'],
    [{ entity_type: 'card_comment', action: 'archive' as never, project_id: 0, summary: ' ' }, 'changed comment'],
    [{ entity_type: 'approval_request', action: 'create', project_id: 0, summary: 'Bob asks to join Design' }, 'added approval request "Bob asks to join Design"'],
  ])('words %o as "%s"', (overrides, text) => {
    const view = render(<ActivityFeed />);
    push(view, change(overrides));
    expect(screen.getByRole('status')).toHaveTextContent(text);
  });

  it('coalesces a burst from one user in one project into a single counted toast', () => {
    const view = render(<ActivityFeed />);
    push(view, change(), change({ entity_type: 'subphase' }), change({ entity_type: 'subphase' }));
    expect(toastTexts()).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('made 3 changes in Bioprocess Scale-Up');

    // A non-project bucket keeps its own toast and wording.
    push(view, change({ project_id: 0, entity_type: 'skill' }), change({ project_id: 0, entity_type: 'skill' }));
    expect(toastTexts()).toHaveLength(2);
    expect(toastTexts()[1]).toContain('made 2 changes');
  });

  it('does not re-ingest a change it has already shown', () => {
    const view = render(<ActivityFeed />);
    const c = change();
    push(view, c);
    setChanges([c]);
    expect(screen.getByRole('status')).not.toHaveTextContent('made 2 changes');
  });

  it('drops changes from projects of another site', () => {
    const view = render(<ActivityFeed />);
    push(view, change({ project_id: 2 }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Unknown projects are shown (cannot be classified).
    push(view, change({ project_id: 99 }));
    expect(screen.getByRole('status')).toHaveTextContent('updated phase "Feasibility"');
  });

  it('keeps at most four toasts, one per user, with initials avatars', () => {
    const view = render(<ActivityFeed />);
    push(
      view,
      change({ user_id: 1, user_name: 'Ada' }),
      change({ user_id: 2, user_name: 'Carol Chen' }),
      change({ user_id: 3, user_name: 'Dan  de  Vries' }),
      change({ user_id: 5, user_name: 'Eve Evans' }),
      change({ user_id: 6, user_name: 'Fay Fox' })
    );
    const texts = toastTexts();
    expect(texts).toHaveLength(4);
    expect(texts[0].startsWith('CCCarol Chen')).toBe(true);
    expect(texts[1].startsWith('DVDan  de  Vries')).toBe(true);
    expect(texts[3].startsWith('FFFay Fox')).toBe(true);
  });

  it('dismisses a toast on click and expires the rest after six seconds', () => {
    const view = render(<ActivityFeed />);
    push(view, change({ user_id: 1, user_name: 'Ada' }), change({ user_id: 2, user_name: 'Carol Chen' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    expect(toastTexts()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows changes from every site when no site is selected', () => {
    useAppStore.setState({ currentSite: null });
    const view = render(<ActivityFeed />);
    push(view, change({ project_id: 2 }));
    expect(screen.getByRole('status')).toHaveTextContent('in Other Site Project');
  });
});
