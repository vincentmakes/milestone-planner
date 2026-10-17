/**
 * viewStore date navigation (F1-23): month steps clamp to the month end like
 * the rest of the app (date-fns), and resetView restores today's date, not
 * the date the module was loaded on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useViewStore } from '../viewStore';
import { useWhatIfStore } from '../whatIfStore';

describe('viewStore.navigatePeriod', () => {
  beforeEach(() => {
    useViewStore.setState({ viewMode: 'month', currentDate: new Date(2026, 0, 31) });
  });

  it('steps one month from Jan 31 to Feb 28, not into March', () => {
    useViewStore.getState().navigatePeriod(1);
    const d = useViewStore.getState().currentDate;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 1, 28]);
  });

  it('steps a quarter from Nov 30 to Feb 28', () => {
    useViewStore.setState({ viewMode: 'quarter', currentDate: new Date(2025, 10, 30) });
    useViewStore.getState().navigatePeriod(1);
    const d = useViewStore.getState().currentDate;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 1, 28]);
  });

  it('steps a week and a year', () => {
    useViewStore.setState({ viewMode: 'week', currentDate: new Date(2026, 2, 27) });
    useViewStore.getState().navigatePeriod(-1);
    let d = useViewStore.getState().currentDate;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 20]);

    useViewStore.setState({ viewMode: 'year', currentDate: new Date(2028, 1, 29) });
    useViewStore.getState().navigatePeriod(1);
    d = useViewStore.getState().currentDate;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2029, 1, 28]);
  });
});

describe('viewStore.resetView', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets the current date to today at call time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2031, 5, 15, 10, 0, 0));

    useViewStore.getState().resetView();

    const d = useViewStore.getState().currentDate;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2031, 5, 15]);
  });
});

describe('viewStore tag filters', () => {
  const KEY = 'milestone-view-storage-v1';

  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ tagFilters: {} });
  });

  it('keeps one filter per site, deduped; an empty filter or clear removes it', () => {
    const { setTagFilter, clearTagFilter } = useViewStore.getState();
    setTagFilter(1, { tagIds: [3, 3, 4], noneGroupIds: [2] });
    setTagFilter(2, { tagIds: [9], noneGroupIds: [] });
    // Single-tenant URL → empty tenant part.
    expect(useViewStore.getState().tagFilters).toEqual({
      ':1': { tagIds: [3, 4], noneGroupIds: [2] },
      ':2': { tagIds: [9], noneGroupIds: [] },
    });

    setTagFilter(2, { tagIds: [], noneGroupIds: [] });
    clearTagFilter(1);
    clearTagFilter(42);
    expect(useViewStore.getState().tagFilters).toEqual({});
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setTagFilter(5, { tagIds: [7], noneGroupIds: [1] });
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.tagFilters).toEqual({ ':5': { tagIds: [7], noneGroupIds: [1] } });

    useViewStore.setState({ tagFilters: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().tagFilters).toEqual({ ':5': { tagIds: [7], noneGroupIds: [1] } });
  });

  it('drops malformed persisted entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          tagFilters: {
            ':1': { tagIds: ['x', 5] },
            ':2': null,
            ':3': { tagIds: [], noneGroupIds: [] },
            'acme:4': { tagIds: [6], noneGroupIds: [] },
            // Legacy site-id-only key: tenant unknown, dropped.
            '5': { tagIds: [7], noneGroupIds: [] },
            'Bad Key:6': { tagIds: [8], noneGroupIds: [] },
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().tagFilters).toEqual({
      ':1': { tagIds: [5], noneGroupIds: [] },
      'acme:4': { tagIds: [6], noneGroupIds: [] },
    });
  });

  it('keys filters by tenant slug + site id, so tenants sharing the origin never mix', () => {
    const { setTagFilter, clearTagFilter } = useViewStore.getState();
    window.history.pushState({}, '', '/t/acme/');
    try {
      setTagFilter(1, { tagIds: [3], noneGroupIds: [] });
      window.history.pushState({}, '', '/t/globex/');
      setTagFilter(1, { tagIds: [9], noneGroupIds: [] });
      expect(useViewStore.getState().tagFilters).toEqual({
        'acme:1': { tagIds: [3], noneGroupIds: [] },
        'globex:1': { tagIds: [9], noneGroupIds: [] },
      });
      clearTagFilter(1);
      expect(useViewStore.getState().tagFilters).toEqual({ 'acme:1': { tagIds: [3], noneGroupIds: [] } });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('viewStore Gantt grouping', () => {
  const KEY = 'milestone-view-storage-v1';

  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
  });

  it('keeps a grouping per site; switching or removing the group clears that site\'s collapsed sections', () => {
    const { setGanttGrouping, toggleGanttSection, setGanttSectionsCollapsed } = useViewStore.getState();
    setGanttGrouping(1, 4);
    setGanttGrouping(2, 5);
    toggleGanttSection(1, 'tag-9');
    toggleGanttSection(1, 'none');
    setGanttSectionsCollapsed(2, ['tag-3', 'tag-3']);
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 4, ':2': 5 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['tag-9', 'none'], ':2': ['tag-3'] });

    // Same group again: nothing changes
    setGanttGrouping(1, 4);
    expect(useViewStore.getState().collapsedGanttSections[':1']).toEqual(['tag-9', 'none']);

    setGanttGrouping(1, 6);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':2': ['tag-3'] });

    setGanttGrouping(2, null);
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 6 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('expand all (an empty list) removes the site entry', () => {
    const { setGanttSectionsCollapsed, toggleGanttSection } = useViewStore.getState();
    setGanttSectionsCollapsed(1, ['tag-1', 'none']);
    setGanttSectionsCollapsed(1, []);
    toggleGanttSection(2, 'none');
    toggleGanttSection(2, 'none');
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setGanttGrouping(5, 3);
    useViewStore.getState().toggleGanttSection(5, 'tag-8');
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.ganttGrouping).toEqual({ ':5': 3 });
    expect(raw.state.collapsedGanttSections).toEqual({ ':5': ['tag-8'] });

    useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':5': 3 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':5': ['tag-8'] });
  });

  it('drops malformed persisted entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          ganttGrouping: {
            ':1': 2,
            'acme:2': 3,
            ':3': '4',
            ':4': 1.5,
            ':5': null,
            // Legacy / malformed keys
            '6': 7,
            'Bad Key:7': 8,
          },
          collapsedGanttSections: {
            ':1': ['tag-1', 'tag-1', 'none', 'tag-x', 5, 'other'],
            ':2': [],
            ':3': 'none',
            '4': ['none'],
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 2, 'acme:2': 3 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['tag-1', 'none'] });
  });

  it('falls back to empty when the persisted values are not objects', async () => {
    useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
    localStorage.setItem(KEY, JSON.stringify({ state: { ganttGrouping: [1], collapsedGanttSections: 'x' }, version: 0 }));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });
});

describe('viewStore Gantt colour by', () => {
  const KEY = 'milestone-view-storage-v1';

  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} });
  });

  it('keeps a colouring group per site, independent of the grouping', () => {
    const { setGanttColorBy, setGanttGrouping } = useViewStore.getState();
    setGanttGrouping(1, 9);
    setGanttColorBy(1, 4);
    setGanttColorBy(2, 5);
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 4, ':2': 5 });

    setGanttColorBy(1, 6);
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 6, ':2': 5 });

    setGanttColorBy(2, null);
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 6 });
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 9 });
  });

  it('leaves the state untouched when nothing changes', () => {
    const { setGanttColorBy } = useViewStore.getState();
    setGanttColorBy(1, 4);
    const before = useViewStore.getState().ganttColorBy;
    setGanttColorBy(1, 4);
    setGanttColorBy(2, null);
    expect(useViewStore.getState().ganttColorBy).toBe(before);
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setGanttColorBy(5, 3);
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.ganttColorBy).toEqual({ ':5': 3 });

    useViewStore.setState({ ganttColorBy: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':5': 3 });
  });

  it('drops malformed persisted entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          ganttColorBy: {
            ':1': 2,
            'acme:2': 3,
            ':3': '4',
            ':4': 1.5,
            ':5': null,
            // Legacy / malformed keys
            '6': 7,
            'Bad Key:7': 8,
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 2, 'acme:2': 3 });
  });

  it('falls back to empty when the persisted value is not an object', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { ganttColorBy: [1] }, version: 0 }));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttColorBy).toEqual({});
  });
});

describe('viewStore.setCurrentView during What-If', () => {
  beforeEach(() => {
    useViewStore.setState({ currentView: 'gantt' });
    useWhatIfStore.getState().enterWhatIfMode([]);
  });

  afterEach(async () => {
    if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
  });

  it('refuses every view other than the Gantt', () => {
    useViewStore.getState().setCurrentView('kanban');
    expect(useViewStore.getState().currentView).toBe('gantt');
    useViewStore.getState().setCurrentView('staff');
    expect(useViewStore.getState().currentView).toBe('gantt');
  });

  it('always allows going back to the Gantt', () => {
    // A sandbox entered from a stale state can still be returned to
    useViewStore.setState({ currentView: 'kanban' });
    useViewStore.getState().setCurrentView('gantt');
    expect(useViewStore.getState().currentView).toBe('gantt');
  });

  it('switches views again once What-If ends', async () => {
    useViewStore.getState().setCurrentView('kanban');
    expect(useViewStore.getState().currentView).toBe('gantt');
    await useWhatIfStore.getState().exitWhatIfMode(false);
    useViewStore.getState().setCurrentView('kanban');
    expect(useViewStore.getState().currentView).toBe('kanban');
  });
});
