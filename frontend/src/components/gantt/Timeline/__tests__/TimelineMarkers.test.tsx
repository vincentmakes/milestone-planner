/**
 * TimelineMarkers — the holiday / company-event strip and its panel: bands
 * by lane, the "+N" pip, span-cell bands with a count, the hit cells' labels,
 * the hover / focus / pin state machine, the panel's listing (teams and
 * closures named) and the click to edit, plus the DOM hygiene the drag hooks
 * rely on (no `data-date`, no class with "row" / "bar").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TimelineMarkers } from '../TimelineMarkers';
import { generateTimelineCells } from '../../utils';
import type { TimelineCell } from '../../utils';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { formatMediumDate } from '@/utils/date';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeTeam, makeUser } from '@/test/factories';
import type { ViewMode } from '@/types';

const EASTER = '2026-04-06';
const GOOD_FRIDAY = '2026-04-03';

const EVENTS = [
  { id: 1, date: EASTER, end_date: '2026-04-07', name: 'ISO 9001 audit', color: '#f59e0b' },
  { id: 2, date: EASTER, name: 'Lab safety walk-through', color: '#14b8a6' },
  { id: 3, date: EASTER, name: 'Instrument calibration day', color: '#a855f7', team_ids: [10] },
  { id: 4, date: '2026-04-08', name: 'Shutdown', counts_as_unavailable: true },
  { id: 5, date: '2026-04-08', name: 'Lab closure', color: '#0ea5e9', counts_as_unavailable: true, team_ids: [10, 11] },
  { id: 6, date: '2026-04-09', name: 'Frankfurt closure', color: '#8b5cf6', counts_as_unavailable: true, team_ids: [20] },
  { id: 7, date: '2026-04-09', name: 'Frankfurt review', color: '#8b5cf6', team_ids: [20] },
  { id: 8, date: '2026-04-20', name: 'Workshop', color: '#123456' },
];
const EVENT_DATES = new Set([EASTER, '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-20']);

function cellsFor(mode: ViewMode): TimelineCell[] {
  return generateTimelineCells(
    new Date(2026, 3, 8),
    mode,
    new Set([EASTER, GOOD_FRIDAY]),
    [
      { date: EASTER, name: 'Easter Monday' },
      { date: GOOD_FRIDAY, name: 'Good Friday' },
    ],
    EVENT_DATES,
    EVENTS
  );
}

const WIDTH = 20;

function renderMarkers({
  mode = 'month' as ViewMode,
  cellWidth = WIDTH,
  showHolidayLine,
  cells = cellsFor(mode),
}: { mode?: ViewMode; cellWidth?: number; showHolidayLine?: boolean; cells?: TimelineCell[] } = {}) {
  const utils = render(
    <div data-testid="scroller" style={{ overflow: 'auto' }}>
      <button type="button">Outside</button>
      <TimelineMarkers
        cells={cells}
        cellWidth={cellWidth}
        viewMode={mode}
        siteId={1}
        showHolidayLine={showHolidayLine}
      />
    </div>
  );
  const indexOf = (dateStr: string) => cells.findIndex((c) => c.dateStr === dateStr);
  const indexOfSpan = (dateStr: string) =>
    cells.findIndex((c, i) => c.dateStr <= dateStr && (cells[i + 1]?.dateStr ?? '9999') > dateStr);
  const layer = utils.container.querySelector<HTMLElement>('[class*="markerLayer"]')!;
  const hit = (index: number) => layer.querySelector<HTMLButtonElement>(`button[data-cell-index="${index}"]`)!;
  const band = (eventId: number) => layer.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`)!;
  return { ...utils, cells, layer, indexOf, indexOfSpan, hit, band };
}

const dialog = () => screen.queryByRole('dialog');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const flushMicrotasks = () => act(async () => {});

beforeEach(() => {
  useAppStore.setState({
    currentUser: makeUser({ role: 'admin' }),
    teams: [
      makeTeam({ id: 10, site_id: 1, name: 'Analytical Lab' }),
      makeTeam({ id: 11, site_id: 1, name: 'QA' }),
      makeTeam({ id: 20, site_id: 2, name: 'Formulation' }),
    ],
  });
  useWhatIfStore.setState({ whatIfMode: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimelineMarkers — day cells', () => {
  it('draws one band per event run on its lane, in the event colour', () => {
    const { band, indexOf } = renderMarkers();
    const audit = band(1);
    expect(audit.style.left).toBe(`${indexOf(EASTER) * WIDTH}px`);
    expect(audit.style.width).toBe(`${2 * WIDTH}px`);
    expect(audit.style.top).toBe('4px'); // lane 1: the holiday holds lane 0
    expect(audit.style.getPropertyValue('--event-color')).toBe('#f59e0b');
    expect(band(3).style.top).toBe('8px');
    expect(band(3).style.width).toBe(`${WIDTH}px`);
    // The third event of Easter Monday finds no lane
    expect(band(2)).toBeNull();
  });

  it('outlines closure bands and leaves the colour to the fallback when an event has none', () => {
    const { band } = renderMarkers();
    expect(band(4).className).toMatch(/closure/);
    expect(band(4).style.top).toBe('0px');
    expect(band(4).style.getPropertyValue('--event-color')).toBe('');
    expect(band(5).className).toMatch(/closure/);
    expect(band(5).style.top).toBe('4px');
    expect(band(1).className).not.toMatch(/closure/);
  });

  it('draws the holiday line on lane 0 of every holiday', () => {
    const { layer, indexOf } = renderMarkers();
    const lines = [...layer.querySelectorAll<HTMLElement>('[class*="holidayLine"]')];
    expect(lines.map((l) => l.style.left)).toEqual([
      `${indexOf(GOOD_FRIDAY) * WIDTH}px`,
      `${indexOf(EASTER) * WIDTH}px`,
    ]);
  });

  it('marks overflow with "+N" on wide cells and a dot on narrow ones', () => {
    const wide = renderMarkers();
    const pip = wide.layer.querySelector<HTMLElement>(`[class*="pip"][data-cell-index="${wide.indexOf(EASTER)}"]`)!;
    expect(pip).toHaveTextContent('+1');
    expect(pip.className).toMatch(/pipCount/);
    expect(pip.style.left).toBe(`${(wide.indexOf(EASTER) + 1) * WIDTH}px`);
    wide.unmount();

    const narrow = renderMarkers({ cellWidth: 12 });
    const dot = narrow.layer.querySelector<HTMLElement>(`[class*="pip"][data-cell-index="${narrow.indexOf(EASTER)}"]`)!;
    expect(dot.className).toMatch(/pipDot/);
    expect(dot).toHaveTextContent('');
  });

  it('without the holiday line draws no holiday, frees lane 0 and offers no holiday-only cell', () => {
    const { layer, band, hit, indexOf } = renderMarkers({ showHolidayLine: false });
    expect(layer.querySelector('[class*="holidayLine"]')).toBeNull();
    expect(band(1).style.top).toBe('0px');
    expect(band(2)).not.toBeNull();
    expect(hit(indexOf(GOOD_FRIDAY))).toBeNull();
    expect(hit(indexOf(EASTER)).getAttribute('aria-label')).not.toMatch(/Bank holiday/);
  });

  it('labels the hit cells with the date, the holiday and every event', () => {
    const { hit, indexOf } = renderMarkers();
    expect(hit(indexOf(EASTER))).toHaveAttribute(
      'aria-label',
      `${formatMediumDate(EASTER)} — Bank holiday Easter Monday; 3 events: ISO 9001 audit, Instrument calibration day, Lab safety walk-through`
    );
    expect(hit(indexOf(GOOD_FRIDAY))).toHaveAttribute(
      'aria-label',
      `${formatMediumDate(GOOD_FRIDAY)} — Bank holiday Good Friday`
    );
    expect(hit(indexOf('2026-04-20'))).toHaveAttribute(
      'aria-label',
      `${formatMediumDate('2026-04-20')} — 1 event: Workshop`
    );
    // Nothing on a plain day
    expect(hit(indexOf('2026-04-14'))).toBeNull();
  });

  it('makes each hit cell a dialog trigger without a native tooltip', () => {
    const { layer } = renderMarkers();
    const hits = [...layer.querySelectorAll('button')];
    expect(hits.length).toBe(6);
    for (const button of hits) {
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).not.toHaveAttribute('aria-controls');
      expect(button).not.toHaveAttribute('title');
      expect(button.className).toMatch(/Badge/);
    }
  });
});

describe('TimelineMarkers — span cells', () => {
  it('draws one band per quarter week in its first event colour, with the count', () => {
    const { layer, cells, indexOfSpan } = renderMarkers({ mode: 'quarter' });
    const workshop = indexOfSpan('2026-04-20');
    const bandEl = layer.querySelector<HTMLElement>(`[class*="band"][data-cell-index="${workshop}"]`)!;
    expect(bandEl.style.left).toBe(`${workshop * WIDTH}px`);
    expect(bandEl.style.width).toBe(`${WIDTH}px`);
    expect(bandEl.style.top).toBe('0px');
    expect(bandEl.style.getPropertyValue('--event-color')).toBe('#123456');
    const count = layer.querySelector(`[class*="pipCount"][data-cell-index="${workshop}"]`);
    expect(count).toHaveTextContent('1');

    const easterWeek = indexOfSpan(EASTER);
    expect(layer.querySelector(`[class*="pipCount"][data-cell-index="${easterWeek}"]`)).toHaveTextContent('7');
    // Its first event is the whole-site closure
    expect(layer.querySelector(`[class*="band"][data-cell-index="${easterWeek}"]`)!.className).toMatch(/closure/);

    // No lanes and no holiday line on span cells
    expect(layer.querySelector('[class*="holidayLine"]')).toBeNull();
    expect(layer.querySelector('[data-event-id]')).toBeNull();
    expect(layer.querySelector(`button[data-cell-index="${workshop}"]`)).toHaveAttribute(
      'aria-label',
      `Week ${cells[workshop].weekNumber} — 1 event: Workshop`
    );
  });

  it('labels a year month with its month and year', () => {
    const { layer, cells } = renderMarkers({ mode: 'year' });
    const april = cells.findIndex((c) => c.dateStr === '2026-04-01');
    const button = layer.querySelector(`button[data-cell-index="${april}"]`)!;
    expect(button.getAttribute('aria-label')).toMatch(new RegExp(`^${cells[april].monthLabel} 2026 — 8 events: Shutdown, `));
    expect(layer.querySelector(`[class*="pipCount"][data-cell-index="${april}"]`)).toHaveTextContent('8');
  });

  it('titles a week panel with its dates and lists only its events', () => {
    const { hit, cells, indexOfSpan } = renderMarkers({ mode: 'quarter' });
    const week = indexOfSpan('2026-04-20');
    fireEvent.click(hit(week));
    const panel = screen.getByRole('dialog', {
      name: `Events on Week ${cells[week].weekNumber} · ${formatMediumDate('2026-04-20')} – ${formatMediumDate('2026-04-26')}`,
    });
    expect(panel).toHaveTextContent('· 1 event');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(1);
  });

  it('titles a month panel with the month and year', () => {
    const { hit, cells } = renderMarkers({ mode: 'year' });
    const april = cells.findIndex((c) => c.dateStr === '2026-04-01');
    fireEvent.click(hit(april));
    expect(screen.getByRole('dialog', { name: `Events on ${cells[april].monthLabel} 2026` })).toHaveTextContent('· 8 events');
  });
});

describe('TimelineMarkers — the panel', () => {
  it('opens on hover after 150 ms and lists every event with swatch, dates and tag', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    advance(149);
    expect(dialog()).toBeNull();
    advance(1);

    const panel = screen.getByRole('dialog', { name: `Events on ${formatMediumDate(EASTER)}` });
    expect(cell).toHaveAttribute('aria-expanded', 'true');
    expect(cell).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveTextContent(`${formatMediumDate(EASTER)} · 3 events`);
    expect(panel).toHaveTextContent('Bank holiday · Easter Monday');

    const items = within(panel).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-event-id'))).toEqual(['1', '3', '2']);
    const swatch = items[0].querySelector<HTMLElement>('[class*="swatch"]')!;
    expect(swatch.style.getPropertyValue('--event-color')).toBe('#f59e0b');
    expect(items[0]).toHaveTextContent(`${formatMediumDate(EASTER)} – ${formatMediumDate('2026-04-07')}`);
    expect(items[1]).toHaveTextContent('Teams: Analytical Lab');
    expect(items[2]).toHaveTextContent(formatMediumDate(EASTER));
    expect(items[2].querySelector('[class*="eventTag"]')).toBeNull();
  });

  it('names closures and teams at this site only', () => {
    const { hit, indexOf } = renderMarkers();
    fireEvent.click(hit(indexOf('2026-04-08')));
    let items = within(dialog()!).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Site closure');
    expect(items[1]).toHaveTextContent('Closure for Analytical Lab, QA');
    expect(items[0].querySelector('[class*="swatch"]')!.className).toMatch(/closure/);

    fireEvent.click(hit(indexOf('2026-04-09')));
    items = within(dialog()!).getAllByRole('listitem');
    // Limited to a team of another site: the whole site here
    expect(items[0]).toHaveTextContent('Site closure');
    expect(items[1].querySelector('[class*="eventTag"]')).toBeNull();
  });

  it('closes 150 ms after the pointer leaves, unless it moves into the panel', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    advance(150);
    fireEvent.mouseLeave(cell);
    fireEvent.mouseEnter(dialog()!);
    advance(500);
    expect(dialog()).not.toBeNull();

    fireEvent.mouseLeave(dialog()!);
    advance(149);
    expect(dialog()).not.toBeNull();
    advance(1);
    expect(dialog()).toBeNull();

    // A pointer that leaves before the delay opens nothing
    fireEvent.mouseEnter(cell);
    advance(100);
    fireEvent.mouseLeave(cell);
    advance(500);
    expect(dialog()).toBeNull();
  });

  it('keeps the panel when the pointer comes back to the cell before the close', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    advance(150);
    fireEvent.mouseLeave(cell);
    advance(100);
    fireEvent.mouseEnter(cell);
    advance(500);
    expect(dialog()).not.toBeNull();
  });

  it('opens on focus; Escape closes it and the cell keeps focus without reopening', async () => {
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    act(() => cell.focus());
    expect(dialog()).not.toBeNull();

    fireEvent.keyDown(cell, { key: 'Escape' });
    await flushMicrotasks();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(cell);

    // A later focus opens it again
    act(() => cell.blur());
    act(() => cell.focus());
    expect(dialog()).not.toBeNull();
  });

  it('Escape from inside the panel puts focus back on the cell without reopening it', async () => {
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    act(() => cell.focus());
    const name = within(dialog()!).getByRole('button', { name: 'ISO 9001 audit' });
    act(() => name.focus());
    expect(dialog()).not.toBeNull();

    fireEvent.keyDown(name, { key: 'Escape' });
    await flushMicrotasks();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(cell);
    expect(cell).toHaveAttribute('aria-expanded', 'false');
  });

  it('pins on click, stays after the pointer leaves, and closes on a second click', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    fireEvent.click(cell);
    expect(dialog()).not.toBeNull();
    advance(150); // the hover timer leaves a pinned panel alone
    fireEvent.mouseLeave(cell);
    advance(500);
    expect(dialog()).not.toBeNull();

    // Hovering another cell does not replace a pinned panel
    fireEvent.mouseEnter(hit(indexOf('2026-04-20')));
    advance(500);
    expect(screen.getByRole('dialog', { name: `Events on ${formatMediumDate(EASTER)}` })).toBeInTheDocument();

    fireEvent.click(cell);
    expect(dialog()).toBeNull();
  });

  it('pins a panel that focus or hover opened, and focus keeps a pinned one', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    act(() => cell.focus());
    fireEvent.click(cell);
    fireEvent.focus(cell);
    fireEvent.mouseLeave(cell);
    advance(500);
    expect(dialog()).not.toBeNull();
    fireEvent.click(cell);
    expect(dialog()).toBeNull();
  });

  it('closes on an outside mousedown, but not on one inside the panel', () => {
    const { hit, indexOf } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    fireEvent.mouseDown(dialog()!);
    expect(dialog()).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(dialog()).toBeNull();
  });

  it('closes when focus leaves the strip and the panel (Tab out), pinned or not', () => {
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    const outside = screen.getByRole('button', { name: 'Outside' });
    fireEvent.click(cell);
    fireEvent.focusOut(cell, { relatedTarget: outside });
    expect(dialog()).toBeNull();

    // Moving to another hit cell keeps one panel, on the new cell
    act(() => cell.focus());
    const other = hit(indexOf('2026-04-20'));
    fireEvent.focusOut(cell, { relatedTarget: other });
    act(() => other.focus());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog()).toHaveAccessibleName(`Events on ${formatMediumDate('2026-04-20')}`);
  });

  it('closes a hover panel when the timeline scrolls, not a pinned one', () => {
    vi.useFakeTimers();
    const { hit, indexOf, getByTestId } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    advance(150);
    // Scrolling the panel itself or an unrelated element changes nothing
    fireEvent.scroll(dialog()!);
    fireEvent.scroll(screen.getByRole('button', { name: 'Outside' }));
    expect(dialog()).not.toBeNull();
    fireEvent.scroll(getByTestId('scroller'));
    expect(dialog()).toBeNull();

    fireEvent.click(cell);
    fireEvent.scroll(getByTestId('scroller'));
    expect(dialog()).not.toBeNull();
  });

  it('shows one panel at a time', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    fireEvent.mouseEnter(hit(indexOf(EASTER)));
    advance(150);
    fireEvent.mouseLeave(hit(indexOf(EASTER)));
    fireEvent.mouseEnter(hit(indexOf('2026-04-20')));
    advance(150);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog()).toHaveAccessibleName(`Events on ${formatMediumDate('2026-04-20')}`);
    expect(hit(indexOf(EASTER))).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(hit(indexOf('2026-04-08')));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog()).toHaveAccessibleName(`Events on ${formatMediumDate('2026-04-08')}`);
  });

  it('drops the panel when its cell is no longer there (a zoom change)', () => {
    const { hit, indexOf, rerender } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    expect(dialog()).not.toBeNull();
    rerender(
      <div data-testid="scroller">
        <button type="button">Outside</button>
        <TimelineMarkers cells={cellsFor('week')} cellWidth={WIDTH} viewMode="week" siteId={1} />
      </div>
    );
    expect(dialog()).toBeNull();
  });

  const strip = (mode: ViewMode) => (
    <div data-testid="scroller">
      <button type="button">Outside</button>
      <TimelineMarkers cells={cellsFor(mode)} cellWidth={WIDTH} viewMode={mode} siteId={1} />
    </div>
  );

  it('closes a pinned panel for good on a zoom change: it does not return at the old zoom', () => {
    const { hit, indexOf, rerender } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    expect(dialog()).not.toBeNull();
    rerender(strip('quarter'));
    expect(dialog()).toBeNull();
    rerender(strip('month'));
    expect(dialog()).toBeNull();
    expect(hit(indexOf(EASTER))).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes a hover panel whose cells changed before its close timer fired', () => {
    vi.useFakeTimers();
    const { hit, indexOf, rerender } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    fireEvent.mouseEnter(cell);
    advance(150);
    expect(dialog()).not.toBeNull();
    fireEvent.mouseLeave(cell);
    rerender(strip('quarter'));
    advance(500);
    rerender(strip('month'));
    expect(dialog()).toBeNull();
  });

  it('closes when new cells of the same zoom no longer hold its cell, and drops a pending hover', () => {
    vi.useFakeTimers();
    const { hit, indexOf, rerender } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    // The same zoom, a range starting a week later: Easter is at another index
    const later = cellsFor('month').slice(7);
    const at = (cells: TimelineCell[]) => (
      <div data-testid="scroller">
        <TimelineMarkers cells={cells} cellWidth={WIDTH} viewMode="month" siteId={1} />
      </div>
    );
    expect(later.findIndex((c) => c.dateStr === EASTER)).not.toBe(indexOf(EASTER));
    rerender(at(later));
    expect(dialog()).toBeNull();
    rerender(at(cellsFor('month')));
    expect(dialog()).toBeNull();

    // A hover intent started on the old cells opens nothing once they change
    fireEvent.mouseEnter(hit(indexOf('2026-04-20')));
    rerender(at([...cellsFor('month')]));
    advance(500);
    expect(dialog()).toBeNull();
  });

  it('keeps a panel whose cells were regenerated with its cell in place', () => {
    const { hit, indexOf, rerender } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    rerender(strip('month'));
    expect(dialog()).not.toBeNull();
  });

  it('opens no hover panel while a mouse button is held (a bar dragged through the strip)', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    fireEvent.mouseEnter(hit(indexOf(EASTER)), { buttons: 1 });
    advance(500);
    expect(dialog()).toBeNull();
  });

  it.each([
    ['a bar drag', () => useUIStore.getState().startDrag('phase', 1)],
    ['a bar resize', () => useUIStore.getState().startResize('phase', 1, 'right')],
    ['a resource drag (body class)', () => document.body.classList.add('resource-dragging')],
  ])('opens no hover or focus panel during %s, and a drag closes an open one', (_, begin) => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    act(() => begin());
    try {
      fireEvent.mouseEnter(cell);
      advance(500);
      expect(dialog()).toBeNull();
      act(() => cell.focus());
      expect(dialog()).toBeNull();
    } finally {
      act(() => {
        useUIStore.getState().endDrag();
        useUIStore.getState().endResize();
        document.body.classList.remove('resource-dragging');
      });
      act(() => cell.blur());
    }

    // Open after the drag; a drag starting during the hover intent opens nothing
    fireEvent.mouseLeave(cell);
    fireEvent.mouseEnter(cell);
    act(() => useUIStore.getState().startDrag('phase', 1));
    advance(500);
    expect(dialog()).toBeNull();
    act(() => useUIStore.getState().endDrag());

    // A hover panel open when a drag starts closes; a pinned one stays
    fireEvent.mouseLeave(cell);
    fireEvent.mouseEnter(cell);
    advance(150);
    expect(dialog()).not.toBeNull();
    act(() => useUIStore.getState().startDrag('phase', 1));
    expect(dialog()).toBeNull();
    act(() => useUIStore.getState().endDrag());
    fireEvent.click(cell);
    act(() => useUIStore.getState().startDrag('phase', 1));
    expect(dialog()).not.toBeNull();
    act(() => useUIStore.getState().endDrag());
  });

  it('closes a hover panel on Escape without moving focus or stopping the key', () => {
    vi.useFakeTimers();
    const { hit, indexOf } = renderMarkers();
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => outside.focus());
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    try {
      fireEvent.mouseEnter(hit(indexOf(EASTER)));
      advance(150);
      expect(dialog()).not.toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(outside);
      // Dependency linking / phantom mode still get the key
      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });

  it('a pinned panel still takes Escape and returns focus to its cell', async () => {
    const { hit, indexOf } = renderMarkers();
    const cell = hit(indexOf(EASTER));
    const outside = screen.getByRole('button', { name: 'Outside' });
    fireEvent.click(cell);
    act(() => outside.focus());
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    try {
      fireEvent.keyDown(outside, { key: 'Escape' });
      await flushMicrotasks();
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(cell);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });

  it('keeps one panel across strips: opening one closes the other strip\'s', () => {
    vi.useFakeTimers();
    const cells = cellsFor('month');
    render(
      <>
        <div data-testid="gantt">
          <TimelineMarkers cells={cells} cellWidth={WIDTH} viewMode="month" siteId={1} />
        </div>
        <div data-testid="overview">
          <TimelineMarkers cells={cells} cellWidth={WIDTH} viewMode="month" siteId={1} />
        </div>
      </>
    );
    const index = cells.findIndex((c) => c.dateStr === EASTER);
    const hitIn = (id: string, i = index) =>
      screen.getByTestId(id).querySelector<HTMLButtonElement>(`button[data-cell-index="${i}"]`)!;

    // A pinned panel in the first strip closes when the second strip hovers open
    fireEvent.click(hitIn('gantt'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.mouseEnter(hitIn('overview'));
    advance(150);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(hitIn('gantt')).toHaveAttribute('aria-expanded', 'false');
    expect(hitIn('overview')).toHaveAttribute('aria-expanded', 'true');

    // And the other way round, by focus
    act(() => hitIn('gantt', cells.findIndex((c) => c.dateStr === '2026-04-20')).focus());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(hitIn('overview')).toHaveAttribute('aria-expanded', 'false');
    expect(dialog()).toHaveAccessibleName(`Events on ${formatMediumDate('2026-04-20')}`);
  });

  it('clears its timers on unmount', () => {
    vi.useFakeTimers();
    const { hit, indexOf, unmount } = renderMarkers();
    fireEvent.mouseEnter(hit(indexOf(EASTER)));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TimelineMarkers — editing an event', () => {
  it('lets a manager open the event in Settings, closing the panel', () => {
    const openSettings = vi.fn();
    useUIStore.setState({ openSettings });
    const { hit, indexOf } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Instrument calibration day' }));
    expect(openSettings).toHaveBeenCalledWith('company-events', { type: 'edit', id: 3, siteId: 1 });
    expect(dialog()).toBeNull();
  });

  it('shows the name as text with the reason during What-If', () => {
    useWhatIfStore.setState({ whatIfMode: true });
    const { hit, indexOf } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    const panel = dialog()!;
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).getByText('ISO 9001 audit')).toHaveAttribute(
      'title',
      whatIfUnavailableMessage('Editing company events in Settings')
    );
  });

  it('shows the name as plain text to someone who may not manage events', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
    const { hit, indexOf } = renderMarkers();
    fireEvent.click(hit(indexOf(EASTER)));
    const panel = dialog()!;
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).getByText('ISO 9001 audit')).not.toHaveAttribute('title');
  });
});

describe('TimelineMarkers — DOM the drag hooks read', () => {
  it.each(['month', 'quarter'] as ViewMode[])('uses no data-date and no "row" / "bar" class (%s zoom)', (mode) => {
    const { layer, hit } = renderMarkers({ mode });
    fireEvent.click(hit(Number(layer.querySelector('button')!.getAttribute('data-cell-index'))));
    const elements = [layer, ...layer.querySelectorAll('*'), dialog()!, ...dialog()!.querySelectorAll('*')];
    expect(elements.length).toBeGreaterThan(10);
    for (const el of elements) {
      expect(el.getAttribute('class') ?? '').not.toMatch(/row|bar/i);
      for (const attr of el.getAttributeNames()) {
        expect(attr).not.toBe('data-date');
        expect(attr).not.toMatch(/row|bar/i);
      }
    }
    expect(document.querySelector('[data-date]')).toBeNull();
  });
});

describe('TimelineMarkers — the count badge and the dot', () => {
  /** The declarations of the first `.selector { … }` block of a stylesheet */
  const rule = (file: string, selector: string) =>
    readFileSync(file, 'utf8').match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  const markers = join(__dirname, '..', 'TimelineMarkers.module.css');
  const sidebar = join(__dirname, '..', '..', '..', 'layout', 'Sidebar', 'Navigation.module.css');
  const prop = (body: string, name: string) => body.match(new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`))?.[1];

  it("wears the sidebar count badge's colours: accent blue, on-accent text", () => {
    const badge = rule(sidebar, 'countBadge');
    expect(prop(badge, 'background')).toBe('var(--accent-blue)');
    expect(prop(badge, 'color')).toBe('var(--text-on-accent)');
    const count = rule(markers, 'pipCount');
    expect(prop(count, 'background')).toBe(prop(badge, 'background'));
    expect(prop(count, 'color')).toBe(prop(badge, 'color'));
    expect(prop(rule(markers, 'pipDot'), 'background')).toBe(prop(badge, 'background'));
  });

  it('keeps the 10 px badge with its radius and 9 px type', () => {
    const count = rule(markers, 'pipCount');
    expect(prop(count, 'height')).toBe('10px');
    expect(prop(count, 'min-width')).toBe('10px');
    expect(prop(count, 'border-radius')).toBe('5px');
    expect(prop(count, 'font-size')).toBe('9px');
  });
});
