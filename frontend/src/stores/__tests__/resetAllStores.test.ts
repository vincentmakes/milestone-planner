/**
 * Logout / session expiry must not leave anything of the previous user
 * behind (F1-13 / F1-15): a What-If queue left in place would be replayed
 * under the next user's session on Apply.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project, User, AppNotification, Site } from '@/types';
import { resetAllStores, expireSession } from '../index';
import * as appStoreModule from '../appStore';
import { useAppStore } from '../appStore';
import { useWhatIfStore } from '../whatIfStore';
import { useUndoStore } from '../undoStore';
import { useNotificationStore } from '../notificationStore';
import { useCustomColumnStore } from '../customColumnStore';
import { useUIStore } from '../uiStore';
import { useViewStore } from '../viewStore';

const PROJECT = { id: 1, name: 'P', site_id: 1, phases: [] } as unknown as Project;
const USER = { id: 9, email: 'a@b.c', first_name: 'A', last_name: 'B', role: 'admin' } as User;

function seedSignedInState() {
  useAppStore.setState({
    isAuthChecking: false,
    isAuthenticated: true,
    currentUser: USER,
    currentSite: { id: 4, name: 'Lab' } as Site,
    _persistedSiteId: 4,
    projects: [PROJECT],
  });
  useWhatIfStore.getState().enterWhatIfMode([PROJECT]);
  useWhatIfStore.getState().queueWhatIfOperation({ method: 'PUT', url: '/api/phases/1', body: {} });
  useUndoStore.getState().saveState([PROJECT], 'drag');
  useNotificationStore.setState({ items: [{ id: 1 } as AppNotification], unreadCount: 1, panelOpen: true });
  useCustomColumnStore.setState({
    customColumns: [{ id: 3 } as never],
    customColumnValues: { '3-phase-1': 'High' },
    customColumnFilters: { 3: ['High'] },
    hiddenCustomColumns: new Set([5]),
    showAllCustomColumns: false,
  });
  useUIStore.setState({ activeModal: 'project', isDragging: true });
  useViewStore.setState({ viewMode: 'quarter' });
}

describe('resetAllStores', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedSignedInState();
  });

  it('clears user data, the What-If queue, undo, notifications, custom-column data and open modals', () => {
    resetAllStores();

    const app = useAppStore.getState();
    expect(app.isAuthenticated).toBe(false);
    expect(app.currentUser).toBeNull();
    expect(app.projects).toEqual([]);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().unreadCount).toBe(0);
    expect(useCustomColumnStore.getState().customColumns).toEqual([]);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({});
    expect(useCustomColumnStore.getState().customColumnFilters).toEqual({});
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('removes the <body> classes of an in-progress gesture or mode (phantom sibling, drags, What-If)', () => {
    document.body.classList.add('phantom-sibling-mode', 'resource-dragging', 'kanban-dragging', 'what-if-mode', 'keep-me');

    resetAllStores();

    expect(document.body.classList.contains('phantom-sibling-mode')).toBe(false);
    expect(document.body.classList.contains('resource-dragging')).toBe(false);
    expect(document.body.classList.contains('kanban-dragging')).toBe(false);
    expect(document.body.classList.contains('what-if-mode')).toBe(false);
    expect(document.body.classList.contains('keep-me')).toBe(true);
    document.body.classList.remove('keep-me');
  });

  it('keeps per-browser preferences (remembered site, view settings, column visibility)', () => {
    resetAllStores();

    expect(useAppStore.getState()._persistedSiteId).toBe(4);
    expect(useViewStore.getState().viewMode).toBe('quarter');
    expect(useCustomColumnStore.getState().hiddenCustomColumns).toEqual(new Set([5]));
    expect(useCustomColumnStore.getState().showAllCustomColumns).toBe(false);
  });

  it('forgets the place in the timeline, so the next sign-in opens on today', () => {
    useViewStore.setState({ timelineScrollLeft: 4321, currentDate: new Date(2024, 0, 15) });
    resetAllStores();
    expect(useViewStore.getState().timelineScrollLeft).toBe(0);
    expect(useViewStore.getState().currentDate.toDateString()).toBe(new Date().toDateString());
  });

  it('keeps store actions working afterwards', () => {
    resetAllStores();
    useUIStore.getState().openModal('project');
    expect(useUIStore.getState().activeModal).toBe('project');
  });
});

describe('expireSession', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedSignedInState();
  });

  it('resets everything and goes straight to the login screen (no auth re-check)', () => {
    expireSession();

    expect(useAppStore.getState().isAuthenticated).toBe(false);
    expect(useAppStore.getState().isAuthChecking).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
  });

  it('is a no-op when nobody is signed in (parallel 401s reset once)', () => {
    expireSession();
    useAppStore.setState({ projects: [PROJECT] }); // e.g. a late response landing
    expireSession();
    expect(useAppStore.getState().projects).toEqual([PROJECT]);
  });
});

describe('appStore selectors', () => {
  it('no longer exports the array-allocating selectors (infinite re-render under Zustand 5)', () => {
    const exported = Object.keys(appStoreModule);
    for (const name of ['selectSiteProjects', 'selectArchivedProjects', 'selectSiteStaff', 'selectSiteEquipment', 'selectIsAdmin']) {
      expect(exported).not.toContain(name);
    }
    expect(exported).toContain('selectCanManageResources');
    expect(exported).toContain('selectStaffSiteIds');
  });
});
