/**
 * Phantom-sibling visuals on the timeline: the overlay (ghost row + bar, lag
 * badge, dashed arrow from the source bar, cursor tracking, click to place)
 * and the standalone PhantomBar / PhantomArrow / PhantomIndicator pieces.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import { PhantomOverlay } from '../PhantomOverlay';
import { PhantomBar } from '../PhantomBar';
import { PhantomArrow } from '../PhantomArrow';
import { PhantomIndicator } from '../PhantomIndicator';
import { calculateBarPosition, generateTimelineCells } from '@/components/gantt/utils';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';

const CELL = 30;
const cells = generateTimelineCells(new Date(2026, 0, 15), 'month', new Set(), []);

type Mode = NonNullable<ReturnType<typeof useUIStore.getState>['phantomSiblingMode']>;

function phantom(overrides: Partial<Mode> = {}): Mode {
  return {
    projectId: 1,
    sourceId: 10,
    type: 'phase',
    dependencyType: 'FS',
    phantomStart: '2026-01-12',
    phantomEnd: '2026-01-16',
    phantomColor: '#3b82f6',
    siblingDurationDays: 5,
    sourceIndex: 0,
    ...overrides,
  };
}

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({
    currentUser: makeUser(),
    projects: [
      makeProject({
        id: 1,
        phases: [
          makePhase({
            id: 10,
            start_date: '2026-01-05',
            end_date: '2026-01-09',
            children: [
              makeSubphase({
                id: 20,
                start_date: '2026-01-05',
                end_date: '2026-01-07',
                children: [makeSubphase({ id: 21, start_date: '2026-01-14', end_date: '2026-01-15' })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
});

describe('PhantomOverlay', () => {
  function setup(mode: Mode | null = phantom()) {
    const timeline = document.createElement('div');
    timeline.getBoundingClientRect = () => ({ left: 100, top: 0, width: 900, height: 400 }) as DOMRect;
    const row = document.createElement('div');
    row.setAttribute('data-phase-id', '10');
    const bar = document.createElement('div');
    bar.className = 'phaseBar';
    bar.getBoundingClientRect = () => ({ left: 160, width: 90, top: 0, height: 20 }) as DOMRect;
    row.appendChild(bar);
    timeline.appendChild(row);
    document.body.appendChild(timeline);

    const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
    ref.current = timeline as HTMLDivElement;
    if (mode) useUIStore.setState({ phantomSiblingMode: mode });

    const utils = render(
      <PhantomOverlay
        cells={cells}
        cellWidth={CELL}
        viewMode="month"
        timelineRef={ref as React.RefObject<HTMLDivElement>}
        containerWidth={900}
        containerHeight={400}
        phantomRowTop={64}
      />,
      { container: timeline.appendChild(document.createElement('div')) }
    );
    return { ...utils, timeline };
  }

  it('renders nothing outside phantom mode', () => {
    setup(null);
    expect(screen.queryByText(/New Phase/)).not.toBeInTheDocument();
  });

  it('draws the ghost bar, the FS lag badge and the arrow once the source bar is found', async () => {
    setup();
    expect(await screen.findByText('New Phase')).toBeInTheDocument();
    // Jan 12 after a source ending Jan 9: two days of slack
    expect(screen.getByText('+2d')).toBeInTheDocument();
    expect(screen.getByText('FS')).toBeInTheDocument();

    const expected = calculateBarPosition('2026-01-12', '2026-01-16', cells, CELL, 'month')!;
    const bar = screen.getByText('New Phase').parentElement as HTMLElement;
    expect(bar.style.left).toBe(`${expected.left}px`);
    expect(bar.style.width).toBe(`${expected.width}px`);
    expect(bar.style.top).toBe('68px');

    // FS arrow leaves the source bar's right edge (60 + 90)
    const arrow = document.querySelector('path[stroke-dasharray]') as SVGPathElement;
    expect(arrow.getAttribute('d')).toMatch(/^M150,/);
  });

  it('shows a negative SS lag for a nested subphase source', async () => {
    const { timeline } = setup(phantom({ type: 'subphase', sourceId: 21, dependencyType: 'SS' }));
    const row = document.createElement('div');
    row.setAttribute('data-subphase-id', '21');
    const sourceBar = document.createElement('div');
    sourceBar.className = 'bar';
    sourceBar.getBoundingClientRect = () => ({ left: 400, width: 60, top: 0, height: 20 }) as DOMRect;
    row.appendChild(sourceBar);
    timeline.appendChild(row);
    act(() => useUIStore.setState({ phantomSiblingMode: phantom({ type: 'subphase', sourceId: 21, dependencyType: 'SS', phantomStart: '2026-01-12' }) }));

    expect(await screen.findByText('New Subphase')).toBeInTheDocument();
    expect(screen.getByText('-2d')).toBeInTheDocument();
    expect(screen.getByText('SS')).toBeInTheDocument();
  });

  it('follows the cursor across the timeline', async () => {
    const { timeline } = setup();
    await screen.findByText('New Phase');
    const firstCell = new Date(cells[0].date);
    // cursor half a cell into day 12: the 5-day ghost is centred on it
    fireEvent.mouseMove(timeline, { clientX: 100 + 12 * CELL + CELL / 2 });
    const { phantomStart, phantomEnd } = useUIStore.getState().phantomSiblingMode!;
    const start = new Date(firstCell);
    start.setDate(start.getDate() + 10);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(phantomStart).toBe(iso(start));
    const end = new Date(start);
    end.setDate(end.getDate() + 4);
    expect(phantomEnd).toBe(iso(end));
  });

  it('places the sibling when the ghost bar is clicked', async () => {
    setup();
    fireEvent.click(await screen.findByText('New Phase'));
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('phase'));
    expect(useUIStore.getState().modalContext.phantomPreset).toMatchObject({
      startDate: '2026-01-12',
      predecessorId: 10,
      dependencyType: 'FS',
    });
  });

  it('places the sibling when the ghost row is clicked', async () => {
    setup();
    const label = await screen.findByText('New Phase');
    const row = label.parentElement!.previousElementSibling as HTMLElement;
    fireEvent.click(row);
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('phase'));
  });

  it('stays hidden while the source bar is not on screen', async () => {
    setup(phantom({ sourceId: 10 }));
    document.querySelector('[data-phase-id="10"]')!.remove();
    act(() => useUIStore.setState({ phantomSiblingMode: phantom({ phantomStart: '2026-01-13' }) }));
    await waitFor(() => expect(screen.queryByText('New Phase')).not.toBeInTheDocument());
  });
});

describe('PhantomBar', () => {
  it('renders the ghost bar centred in the row and reports clicks', () => {
    useUIStore.setState({ phantomSiblingMode: phantom({ type: 'subphase', phantomColor: '#10b981' }) });
    const onClick = vi.fn();
    render(<PhantomBar cells={cells} cellWidth={CELL} viewMode="month" rowTop={100} rowHeight={40} onClick={onClick} />);
    const bar = screen.getByText('New Subphase').parentElement as HTMLElement;
    const expected = calculateBarPosition('2026-01-12', '2026-01-16', cells, CELL, 'month')!;
    expect(bar.style.left).toBe(`${expected.left}px`);
    expect(bar.style.top).toBe('108px');
    expect(bar.style.borderColor).toBe('rgb(16, 185, 129)');
    fireEvent.click(bar);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders nothing outside phantom mode', () => {
    const { container } = render(
      <PhantomBar cells={cells} cellWidth={CELL} viewMode="month" rowTop={0} rowHeight={32} onClick={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PhantomArrow', () => {
  const source = { left: 100, width: 60, top: 40, height: 20 };
  const pathOf = (container: HTMLElement) =>
    container.querySelector('path[stroke-dasharray]')!.getAttribute('d');

  it('routes an FS arrow straight right when the ghost is ahead', () => {
    useUIStore.setState({ phantomSiblingMode: phantom() });
    const toX = calculateBarPosition('2026-01-12', '2026-01-16', cells, CELL, 'month')!.left;
    const { container } = render(
      <PhantomArrow cells={cells} cellWidth={CELL} viewMode="month" sourceBar={source}
        phantomRowTop={80} phantomRowHeight={32} containerWidth={900} containerHeight={300} />
    );
    const midX = 160 + (toX - 160) / 2;
    expect(pathOf(container)).toBe(`M160,50 H${midX} V96 H${toX}`);
  });

  it('routes an FS arrow around when the ghost starts before the source ends', () => {
    useUIStore.setState({ phantomSiblingMode: phantom() });
    const toX = calculateBarPosition('2026-01-12', '2026-01-16', cells, CELL, 'month')!.left;
    const farSource = { ...source, left: toX + 100 };
    const { container } = render(
      <PhantomArrow cells={cells} cellWidth={CELL} viewMode="month" sourceBar={farSource}
        phantomRowTop={80} phantomRowHeight={32} containerWidth={900} containerHeight={300} />
    );
    expect(pathOf(container)).toBe(
      `M${toX + 160},50 H${toX + 175} V116 H${toX - 15} V96 H${toX}`
    );
  });

  it('routes an SS arrow from the source start, around the left', () => {
    useUIStore.setState({ phantomSiblingMode: phantom({ dependencyType: 'SS' }) });
    const toX = calculateBarPosition('2026-01-12', '2026-01-16', cells, CELL, 'month')!.left;
    const { container } = render(
      <PhantomArrow cells={cells} cellWidth={CELL} viewMode="month" sourceBar={source}
        phantomRowTop={80} phantomRowHeight={32} containerWidth={900} containerHeight={300} />
    );
    expect(pathOf(container)).toBe(`M100,50 H${Math.min(100, toX) - 15} V96 H${toX}`);
  });

  it('draws nothing without a source bar', () => {
    useUIStore.setState({ phantomSiblingMode: phantom() });
    const { container } = render(
      <PhantomArrow cells={cells} cellWidth={CELL} viewMode="month" sourceBar={null}
        phantomRowTop={80} phantomRowHeight={32} containerWidth={900} containerHeight={300} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PhantomIndicator', () => {
  it('shows a positive FS lag above the ghost bar', () => {
    useUIStore.setState({ phantomSiblingMode: phantom() });
    render(<PhantomIndicator cells={cells} cellWidth={CELL} viewMode="month" phantomRowTop={100} />);
    const badge = screen.getByText('+2d').parentElement as HTMLElement;
    expect(badge.className).toMatch(/positive/);
    expect(badge.style.top).toBe('72px');
    expect(screen.getByText('FS')).toBeInTheDocument();
  });

  it('shows a negative SS lag for a subphase source', () => {
    useUIStore.setState({
      phantomSiblingMode: phantom({ type: 'subphase', sourceId: 21, dependencyType: 'SS' }),
    });
    render(<PhantomIndicator cells={cells} cellWidth={CELL} viewMode="month" phantomRowTop={100} />);
    expect(screen.getByText('-2d').parentElement!.className).toMatch(/negative/);
  });

  it('shows nothing when the project or the source is unknown', () => {
    useUIStore.setState({ phantomSiblingMode: phantom({ projectId: 99 }) });
    const { container, rerender } = render(
      <PhantomIndicator cells={cells} cellWidth={CELL} viewMode="month" phantomRowTop={100} />
    );
    expect(container).toBeEmptyDOMElement();
    act(() => useUIStore.setState({ phantomSiblingMode: phantom({ type: 'subphase', sourceId: 99 }) }));
    rerender(<PhantomIndicator cells={cells} cellWidth={CELL} viewMode="month" phantomRowTop={100} />);
    expect(container).toBeEmptyDOMElement();
  });
});
