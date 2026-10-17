/**
 * Timeline render isolation (F2-10/F2-11).
 *
 * - Scrolling sets the print offset as a CSS variable on the scroll
 *   container instead of in state, so it no longer re-renders the body.
 * - TimelineBody is memoised and reads the per-mousemove UI state (drag
 *   indicator, phantom position) through narrow selectors, so a drag does
 *   not rebuild every project row and the row positions per frame.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Timeline } from '../Timeline';
import { TimelineBody } from '../TimelineBody';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import type { Project } from '@/types';

const counters = vi.hoisted(() => ({ projectRows: 0, rowPositions: new Set<unknown>() }));

// Not memoised: renders whenever TimelineBody renders
vi.mock('../ProjectTimeline', () => ({
  ProjectTimeline: () => {
    counters.projectRows++;
    return null;
  },
}));
vi.mock('../DependencyLayer', () => ({
  DependencyLayer: ({ rowPositions }: { rowPositions: unknown }) => {
    counters.rowPositions.add(rowPositions);
    return null;
  },
}));

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  start_date: '2026-03-01',
  end_date: '2026-03-31',
  phases: [{ id: 10, name: 'Design', dependencies: [], children: [], staffAssignments: [], equipmentAssignments: [] }],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

const cells = generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), []);
const projects = [project];

beforeEach(() => {
  counters.projectRows = 0;
  counters.rowPositions.clear();
  useUIStore.setState({ phantomSiblingMode: null });
  useViewStore.setState({ viewMode: 'month', timelineScrollLeft: 0 });
});

describe('TimelineBody render isolation', () => {
  function renderBody() {
    return render(
      <TimelineBody cells={cells} projects={projects} cellWidth={30} totalWidth={cells.length * 30} viewMode="month" />
    );
  }

  it('does not re-render on drag-indicator updates', () => {
    renderBody();
    const before = counters.projectRows;

    act(() => useUIStore.getState().showDragIndicator(100, 20, 2));
    act(() => useUIStore.getState().showDragIndicator(130, 20, 3));
    act(() => useUIStore.getState().hideIndicator());

    expect(counters.projectRows).toBe(before);
  });

  it('keeps the row positions while the phantom sibling follows the pointer', () => {
    act(() =>
      useUIStore.getState().startPhantomSibling({
        projectId: 1,
        sourceId: 10,
        type: 'phase',
        dependencyType: 'FS',
        phantomStart: '2026-03-10',
        phantomEnd: '2026-03-12',
        phantomColor: '#000',
        siblingDurationDays: 3,
        sourceIndex: 0,
      } as never)
    );
    renderBody();
    const rows = counters.projectRows;
    const positions = counters.rowPositions.size;

    act(() => useUIStore.getState().updatePhantomPosition('2026-03-11', '2026-03-13'));
    act(() => useUIStore.getState().updatePhantomPosition('2026-03-12', '2026-03-14'));

    expect(counters.projectRows).toBe(rows);
    expect(counters.rowPositions.size).toBe(positions);
  });
});

describe('Timeline scroll', () => {
  it('sets the print offset on the scroll container without re-rendering the body', () => {
    const { container } = render(
      <Timeline
        cells={cells}
        headers={generateTimelineHeaders(cells, 'month')}
        projects={projects}
        cellWidth={30}
        viewMode="month"
      />
    );
    const scroller = container.querySelector('[class*="horizontalScroll"]') as HTMLDivElement;
    expect(scroller).not.toBeNull();
    const before = counters.projectRows;

    scroller.scrollLeft = 240;
    act(() => {
      fireEvent.scroll(scroller);
    });

    expect(scroller.style.getPropertyValue('--print-scroll-left')).toBe('-240px');
    expect(counters.projectRows).toBe(before);
  });
});
