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

describe('viewStore project filters', () => {
  const KEY = 'milestone-view-storage-v1';
  const empty = { optionIds: [], noneFieldIds: [], tagIds: [] };

  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ projectFilters: {} });
  });

  it('keeps one filter per site, deduped; an empty filter or clear removes it', () => {
    const { setProjectFilter, clearProjectFilter } = useViewStore.getState();
    setProjectFilter(1, { optionIds: [3, 3, 4], noneFieldIds: [2, 2], tagIds: [8, 8] });
    setProjectFilter(2, { ...empty, tagIds: [9] });
    // Single-tenant URL → empty tenant part.
    expect(useViewStore.getState().projectFilters).toEqual({
      ':1': { optionIds: [3, 4], noneFieldIds: [2], tagIds: [8] },
      ':2': { ...empty, tagIds: [9] },
    });

    setProjectFilter(2, empty);
    clearProjectFilter(1);
    clearProjectFilter(42);
    expect(useViewStore.getState().projectFilters).toEqual({});
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setProjectFilter(5, { optionIds: [7], noneFieldIds: [1], tagIds: [2] });
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.projectFilters).toEqual({ ':5': { optionIds: [7], noneFieldIds: [1], tagIds: [2] } });

    useViewStore.setState({ projectFilters: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().projectFilters).toEqual({
      ':5': { optionIds: [7], noneFieldIds: [1], tagIds: [2] },
    });
  });

  it('drops malformed persisted entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          projectFilters: {
            ':1': { optionIds: ['x', 5] },
            ':2': null,
            ':3': empty,
            'acme:4': { noneFieldIds: [6] },
            ':5': { tagIds: [1.5, 7] },
            // Legacy site-id-only key: tenant unknown, dropped.
            '5': { ...empty, optionIds: [7] },
            'Bad Key:6': { ...empty, optionIds: [8] },
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().projectFilters).toEqual({
      ':1': { ...empty, optionIds: [5] },
      'acme:4': { ...empty, noneFieldIds: [6] },
      ':5': { ...empty, tagIds: [7] },
    });
  });

  it('drops the pre-2.0 tag filters on load and never writes them back', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { tagFilters: { ':1': { tagIds: [3], noneGroupIds: [2] } } },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().projectFilters).toEqual({});
    expect('tagFilters' in useViewStore.getState()).toBe(false);

    useViewStore.getState().setProjectFilter(1, { ...empty, optionIds: [4] });
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.tagFilters).toBeUndefined();
    expect(raw.state.projectFilters).toEqual({ ':1': { ...empty, optionIds: [4] } });
  });

  it('falls back to empty when the persisted value is not an object', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { projectFilters: [1] }, version: 0 }));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().projectFilters).toEqual({});
  });

  it('keys filters by tenant slug + site id, so tenants sharing the origin never mix', () => {
    const { setProjectFilter, clearProjectFilter } = useViewStore.getState();
    window.history.pushState({}, '', '/t/acme/');
    try {
      setProjectFilter(1, { ...empty, optionIds: [3] });
      window.history.pushState({}, '', '/t/globex/');
      setProjectFilter(1, { ...empty, optionIds: [9] });
      expect(useViewStore.getState().projectFilters).toEqual({
        'acme:1': { ...empty, optionIds: [3] },
        'globex:1': { ...empty, optionIds: [9] },
      });
      clearProjectFilter(1);
      expect(useViewStore.getState().projectFilters).toEqual({ 'acme:1': { ...empty, optionIds: [3] } });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('viewStore team filters', () => {
  const KEY = 'milestone-view-storage-v1';

  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ teamFilters: {} });
  });

  it('keeps one filter per site, deduped; an empty filter or clear removes it', () => {
    const { setTeamFilter, clearTeamFilter } = useViewStore.getState();
    setTeamFilter(1, { teamIds: [3, 3, 4], noTeam: true });
    setTeamFilter(2, { teamIds: [9], noTeam: false });
    setTeamFilter(3, { teamIds: [], noTeam: true });
    // Single-tenant URL → empty tenant part.
    expect(useViewStore.getState().teamFilters).toEqual({
      ':1': { teamIds: [3, 4], noTeam: true },
      ':2': { teamIds: [9], noTeam: false },
      ':3': { teamIds: [], noTeam: true },
    });

    setTeamFilter(2, { teamIds: [], noTeam: false });
    clearTeamFilter(1);
    clearTeamFilter(3);
    clearTeamFilter(42);
    expect(useViewStore.getState().teamFilters).toEqual({});
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setTeamFilter(5, { teamIds: [7], noTeam: true });
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.teamFilters).toEqual({ ':5': { teamIds: [7], noTeam: true } });

    useViewStore.setState({ teamFilters: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().teamFilters).toEqual({ ':5': { teamIds: [7], noTeam: true } });
  });

  it('drops malformed persisted entries', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          teamFilters: {
            ':1': { teamIds: ['x', 5] },
            ':2': null,
            ':3': { teamIds: [], noTeam: false },
            ':4': { teamIds: 'nope', noTeam: 'yes' },
            ':5': { noTeam: true },
            'acme:6': { teamIds: [6], noTeam: false },
            // Legacy site-id-only key: tenant unknown, dropped.
            '7': { teamIds: [7], noTeam: false },
            'Bad Key:8': { teamIds: [8], noTeam: false },
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().teamFilters).toEqual({
      ':1': { teamIds: [5], noTeam: false },
      ':5': { teamIds: [], noTeam: true },
      'acme:6': { teamIds: [6], noTeam: false },
    });
  });

  it('keys filters by tenant slug + site id, so tenants sharing the origin never mix', () => {
    const { setTeamFilter, clearTeamFilter } = useViewStore.getState();
    window.history.pushState({}, '', '/t/acme/');
    try {
      setTeamFilter(1, { teamIds: [3], noTeam: false });
      window.history.pushState({}, '', '/t/globex/');
      setTeamFilter(1, { teamIds: [9], noTeam: false });
      expect(useViewStore.getState().teamFilters).toEqual({
        'acme:1': { teamIds: [3], noTeam: false },
        'globex:1': { teamIds: [9], noTeam: false },
      });
      clearTeamFilter(1);
      expect(useViewStore.getState().teamFilters).toEqual({ 'acme:1': { teamIds: [3], noTeam: false } });
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
    toggleGanttSection(1, 'field-9');
    toggleGanttSection(1, 'none');
    setGanttSectionsCollapsed(2, ['field-3', 'field-3']);
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 4, ':2': 5 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['field-9', 'none'], ':2': ['field-3'] });

    // Same group again: nothing changes
    setGanttGrouping(1, 4);
    expect(useViewStore.getState().collapsedGanttSections[':1']).toEqual(['field-9', 'none']);

    setGanttGrouping(1, 6);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':2': ['field-3'] });

    setGanttGrouping(2, null);
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 6 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('expand all (an empty list) removes the site entry', () => {
    const { setGanttSectionsCollapsed, toggleGanttSection } = useViewStore.getState();
    setGanttSectionsCollapsed(1, ['field-1', 'none']);
    setGanttSectionsCollapsed(1, []);
    toggleGanttSection(2, 'none');
    toggleGanttSection(2, 'none');
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('survives a reload (partialize + merge round-trip)', async () => {
    useViewStore.getState().setGanttGrouping(5, 3);
    useViewStore.getState().toggleGanttSection(5, 'field-8');
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.ganttGrouping).toEqual({ ':5': 3 });
    expect(raw.state.collapsedGanttSections).toEqual({ ':5': ['field-8'] });

    useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':5': 3 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':5': ['field-8'] });
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
            // Pre-2.0 `tag-<id>` keys belong to tag groups: dropped
            ':1': ['field-1', 'field-1', 'none', 'field-x', 5, 'other', 'tag-4'],
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
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['field-1', 'none'] });
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

  it('keeps a colouring choice per site, independent of the grouping', () => {
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

    setGanttColorBy(1, 'tags');
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 'tags' });
  });

  it('leaves the state untouched when nothing changes', () => {
    const { setGanttColorBy } = useViewStore.getState();
    setGanttColorBy(1, 4);
    const before = useViewStore.getState().ganttColorBy;
    setGanttColorBy(1, 4);
    setGanttColorBy(2, null);
    expect(useViewStore.getState().ganttColorBy).toBe(before);
  });

  it('survives a reload (partialize + merge round-trip), "tags" included', async () => {
    useViewStore.getState().setGanttColorBy(5, 3);
    useViewStore.getState().setGanttColorBy(6, 'tags');
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state.ganttColorBy).toEqual({ ':5': 3, ':6': 'tags' });

    useViewStore.setState({ ganttColorBy: {} });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':5': 3, ':6': 'tags' });
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
            ':8': 'tags',
            ':9': 'Tags',
            // Legacy / malformed keys
            '6': 7,
            'Bad Key:7': 8,
          },
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 2, 'acme:2': 3, ':8': 'tags' });
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
