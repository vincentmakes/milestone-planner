/**
 * DashboardGrid with react-grid-layout mounted in jsdom (the container width
 * is given through a mocked useContainerWidth, jsdom measures 0): one grid
 * item per widget at its stored position for the breakpoint of the
 * container width; nothing drags or resizes in view mode; a drag's or a
 * resize's report tagged as a gesture, the library's own as settling; the
 * conversions between widget layouts and the library's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DashboardGrid } from '../DashboardGrid';
import { fromGridLayouts, GRID_BREAKPOINTS, GRID_COLS, GRID_MARGIN, GRID_ROW_HEIGHT, toGridLayouts } from '../gridLayouts';
import type { DashboardWidget, MetricResult } from '@/types';

const container = vi.hoisted(() => ({ width: 1200, mounted: true }));

vi.mock('react-grid-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-grid-layout')>();
  return {
    ...actual,
    useContainerWidth: () => ({
      width: container.width,
      mounted: container.mounted,
      containerRef: { current: null },
      measureWidth: () => {},
    }),
  };
});

vi.mock('../charts/EChart', () => ({ EChart: () => <div data-testid="echart" /> }));

const widget = (id: number, lg: [number, number, number, number], md: [number, number, number, number]): DashboardWidget => {
  const pos = ([x, y, w, h]: [number, number, number, number]) => ({ x, y, w, h });
  return {
    id,
    kind: 'kpi',
    title: `KPI ${id}`,
    query: { measure: 'project_count' },
    options: {},
    layout: { lg: pos(lg), md: pos(md), sm: { x: 0, y: id * 2, w: 4, h: 2 } },
    sort_order: id,
  };
};

const widgets = [widget(1, [0, 0, 3, 2], [0, 0, 4, 2]), widget(2, [3, 0, 3, 2], [4, 0, 4, 2]), widget(3, [0, 2, 6, 5], [0, 2, 8, 5])];

const data: Record<number, MetricResult> = {
  1: { unit: 'projects', dimensions: [], rows: [{ keys: [], value: 4 }], total: 4, truncated: false, warnings: [] },
};

/** The library's CSS transform of a grid item. */
const items = () => [...document.querySelectorAll<HTMLElement>('.react-grid-item')];
const translate = (el: HTMLElement) => el.style.transform;

beforeEach(() => {
  container.width = 1200;
  container.mounted = true;
});

describe('DashboardGrid', () => {
  it('uses the agreed geometry', () => {
    expect(GRID_BREAKPOINTS).toEqual({ lg: 1000, md: 700, sm: 0 });
    expect(GRID_COLS).toEqual({ lg: 12, md: 8, sm: 4 });
    expect(GRID_ROW_HEIGHT).toBe(80);
    expect(GRID_MARGIN).toEqual([12, 12]);
  });

  it('places one item per widget at its lg position on a wide container', () => {
    render(<DashboardGrid widgets={widgets} data={data} />);
    const rendered = items();
    expect(rendered).toHaveLength(3);
    expect(rendered.map((el) => el.dataset.widgetId)).toEqual(['1', '2', '3']);
    // 12 columns over 1200 px with 12 px margins and padding: 87 px per column
    expect(translate(rendered[0])).toBe('translate(12px,12px)');
    expect(translate(rendered[1])).toBe('translate(309px,12px)');
    expect(translate(rendered[2])).toBe('translate(12px,196px)');
    expect(rendered[2].style.width).toBe('582px');
    expect(rendered[2].style.height).toBe('448px');
    expect(screen.getByRole('region', { name: 'KPI 1' })).toHaveTextContent('4');
  });

  it('switches to the md layout on a narrower container', () => {
    container.width = 800;
    render(<DashboardGrid widgets={widgets} data={data} />);
    const rendered = items();
    // 8 columns over 800 px: 86.5 px per column → the second widget at x = 4
    expect(translate(rendered[1])).toBe('translate(406px,12px)');
    expect(rendered[2].style.width).toBe('776px');
  });

  it('shows the resize corner in edit mode only, inside the editing grid', () => {
    const { container: root, unmount } = render(<DashboardGrid widgets={widgets} data={data} />);
    // View mode: the library hides every handle (display: none on .react-resizable-hide)
    // and the grid carries no editing class, so the edit-mode corner style never applies.
    const hidden = [...root.querySelectorAll('.react-grid-item > .react-resizable-handle')];
    expect(hidden.every((h) => h.parentElement?.classList.contains('react-resizable-hide'))).toBe(true);
    expect(root.querySelector('[class*="editing"]')).toBeNull();
    unmount();
    const editing = render(<DashboardGrid widgets={widgets} data={data} editing />).container;
    const handles = editing.querySelectorAll('.react-grid-item > .react-resizable-handle.react-resizable-handle-se');
    expect(handles).toHaveLength(widgets.length);
    expect([...handles].some((h) => h.parentElement?.classList.contains('react-resizable-hide'))).toBe(false);
    // The edit-mode rule that styles it (DashboardGrid.module.css) scopes on the editing class.
    expect(handles[0].closest('[class*="editing"]')).not.toBeNull();
  });

  it('neither drags nor resizes in view mode', () => {
    const { container: root } = render(<DashboardGrid widgets={widgets} data={data} />);
    // The library hides the resize handles and does not make items draggable
    expect(items().every((el) => el.classList.contains('react-resizable-hide'))).toBe(true);
    expect(root.querySelectorAll('.react-draggable')).toHaveLength(0);
    expect(root.querySelector('[data-testid="DragIndicatorIcon"]')).toBeNull();
  });

  it('drags by the header and resizes from the bottom-right corner while editing', () => {
    const { container: root } = render(<DashboardGrid widgets={widgets} data={data} editing />);
    expect(items().every((el) => el.classList.contains('react-draggable'))).toBe(true);
    expect(items().some((el) => el.classList.contains('react-resizable-hide'))).toBe(false);
    expect(root.querySelectorAll('.react-resizable-handle-se')).toHaveLength(3);
    expect(root.querySelectorAll('.react-resizable-handle')).toHaveLength(3);
    expect(root.querySelectorAll('.widgetHeader [data-testid="DragIndicatorIcon"]')).toHaveLength(3);
  });

  it('hands the widget headers’ Edit and Remove to the builder while editing, by widget id', () => {
    const onEditWidget = vi.fn();
    const onRemoveWidget = vi.fn();
    render(
      <DashboardGrid widgets={widgets} data={data} editing onEditWidget={onEditWidget} onRemoveWidget={onRemoveWidget} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit KPI 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove KPI 3' }));
    expect(onEditWidget).toHaveBeenCalledWith(2);
    expect(onRemoveWidget).toHaveBeenCalledWith(3);
  });

  it('shows no Edit or Remove button without the builder’s handlers', () => {
    render(<DashboardGrid widgets={widgets} data={data} editing />);
    expect(screen.queryByRole('button', { name: /^Edit KPI/ })).not.toBeInTheDocument();
  });

  it('renders nothing until the container is measured', () => {
    container.mounted = false;
    render(<DashboardGrid widgets={widgets} data={data} />);
    expect(items()).toHaveLength(0);
  });

  it('reports every widget’s layout when the layout changes', () => {
    const onLayoutChange = vi.fn();
    const { rerender } = render(
      <DashboardGrid widgets={widgets.slice(0, 2)} data={data} onLayoutChange={onLayoutChange} />
    );
    rerender(<DashboardGrid widgets={widgets} data={data} onLayoutChange={onLayoutChange} />);
    expect(onLayoutChange).toHaveBeenCalled();
    const last = onLayoutChange.mock.calls[onLayoutChange.mock.calls.length - 1][0];
    expect(Object.keys(last)).toEqual(['1', '2', '3']);
    expect(last[2].lg).toEqual(widgets[1].layout.lg);
  });

  // A pixel resize of the bottom-right corner: press at (x, y), one move by
  // (dx, dy) per step, release. jsdom measures every box as 0, so the
  // library reads the pointer as client coordinates.
  const resizeCorner = (handle: Element, steps: Array<[number, number]>) => {
    let x = 1000;
    let y = 500;
    fireEvent.mouseDown(handle, { button: 0, clientX: x, clientY: y });
    for (const [dx, dy] of steps) {
      x += dx;
      y += dy;
      fireEvent.mouseMove(document, { button: 0, buttons: 1, clientX: x, clientY: y });
    }
    fireEvent.mouseUp(document, { button: 0, clientX: x, clientY: y });
  };
  const rightPair = [widget(1, [0, 0, 6, 2], [0, 0, 4, 2]), widget(2, [6, 0, 4, 2], [4, 0, 4, 2])];
  const lastLg = (spy: ReturnType<typeof vi.fn>, id: number) =>
    spy.mock.calls[spy.mock.calls.length - 1][0][id].lg;

  it('grows a widget to the right edge when the pointer passes the edge in one move', () => {
    // 12 columns over 1200 px: 87 px per column, the widget at x = 6 starts
    // at 606 px, 4 columns = 384 px. One move of 400 px goes past the grid's
    // right edge: the widget takes the 6 columns left, it is not refused.
    const onLayoutChange = vi.fn();
    const { container: root } = render(
      <DashboardGrid widgets={rightPair} data={data} editing onLayoutChange={onLayoutChange} />
    );
    onLayoutChange.mockClear();
    const handle = root.querySelector('[data-widget-id="2"] > .react-resizable-handle-se')!;
    resizeCorner(handle, [[400, 0]]);
    expect(onLayoutChange).toHaveBeenCalled();
    expect(lastLg(onLayoutChange, 2)).toEqual({ x: 6, y: 0, w: 6, h: 2 });
  });

  it('grows back after a shrink, also past the edge, and in height', () => {
    const onLayoutChange = vi.fn();
    const { container: root, rerender } = render(
      <DashboardGrid widgets={rightPair} data={data} editing onLayoutChange={onLayoutChange} />
    );
    const handle = () => root.querySelector('[data-widget-id="2"] > .react-resizable-handle-se')!;
    // Shrink by two columns and a row, as the builder stores it
    resizeCorner(handle(), [[-99, -46], [-99, -46]]);
    const shrunk = lastLg(onLayoutChange, 2);
    expect(shrunk).toEqual({ x: 6, y: 0, w: 2, h: 1 });
    const stored = rightPair.map((w) => (w.id === 2 ? { ...w, layout: { ...w.layout, lg: shrunk } } : w));
    rerender(<DashboardGrid widgets={stored} data={data} editing onLayoutChange={onLayoutChange} />);
    // Then back out in two coarse moves, the last one past the right edge
    resizeCorner(handle(), [[150, 60], [300, 60]]);
    expect(lastLg(onLayoutChange, 2)).toEqual({ x: 6, y: 0, w: 6, h: 2 });
  });

  // Every source the change listener was given since the last clear.
  const sources = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((call) => call[1]);

  it('tags the report a resize ends with as a gesture, and the library’s own as settling', async () => {
    const onLayoutChange = vi.fn();
    const { container: root, rerender } = render(
      <DashboardGrid widgets={rightPair} data={data} editing onLayoutChange={onLayoutChange} />
    );
    expect(sources(onLayoutChange).every((source) => source === 'settle')).toBe(true);
    onLayoutChange.mockClear();

    const handle = root.querySelector('[data-widget-id="2"] > .react-resizable-handle-se')!;
    resizeCorner(handle, [[-99, 0]]);
    expect(onLayoutChange.mock.calls[0][1]).toBe('gesture');
    expect(onLayoutChange.mock.calls[0][0][2].lg).toEqual({ x: 6, y: 0, w: 3, h: 2 });
    await Promise.resolve();

    // A widget taken off afterwards: the compaction is the library's
    onLayoutChange.mockClear();
    const below = [rightPair[0], widget(3, [0, 4, 6, 2], [0, 4, 4, 2])];
    rerender(<DashboardGrid widgets={below} data={data} editing onLayoutChange={onLayoutChange} />);
    expect(onLayoutChange).toHaveBeenCalled();
    expect(sources(onLayoutChange).every((source) => source === 'settle')).toBe(true);
    expect(lastLg(onLayoutChange, 3).y).toBe(2);
  });

  it('tags the report a drag by the header ends with as a gesture', async () => {
    const onLayoutChange = vi.fn();
    const { container: root, rerender } = render(
      <DashboardGrid widgets={rightPair} data={data} editing onLayoutChange={onLayoutChange} />
    );
    onLayoutChange.mockClear();
    // jsdom has no offsetParent, which the library needs to start a drag
    const offsetParent = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.parentElement;
      });
    const header = root.querySelector('[data-widget-id="2"] .widgetHeader')!;
    fireEvent.mouseDown(header, { button: 0, clientX: 700, clientY: 20 });
    fireEvent.mouseMove(document, { button: 0, buttons: 1, clientX: 600, clientY: 300 });
    fireEvent.mouseMove(document, { button: 0, buttons: 1, clientX: 500, clientY: 400 });
    fireEvent.mouseUp(document, { button: 0, clientX: 500, clientY: 400 });
    expect(onLayoutChange).toHaveBeenCalled();
    expect(onLayoutChange.mock.calls[0][1]).toBe('gesture');
    await Promise.resolve();

    // A gesture that moves nothing reports nothing, and leaves no mark behind
    onLayoutChange.mockClear();
    fireEvent.mouseDown(header, { button: 0, clientX: 700, clientY: 20 });
    fireEvent.mouseUp(document, { button: 0, clientX: 700, clientY: 20 });
    await Promise.resolve();
    rerender(<DashboardGrid widgets={rightPair.slice(1)} data={data} editing onLayoutChange={onLayoutChange} />);
    expect(onLayoutChange).toHaveBeenCalled();
    expect(sources(onLayoutChange).every((source) => source === 'settle')).toBe(true);
    offsetParent.mockRestore();
  });

  it('bounds every item’s width by the columns right of it', () => {
    const layouts = toGridLayouts(rightPair);
    expect(layouts.lg!.map((l) => l.maxW)).toEqual([12, 6]);
    expect(layouts.md!.map((l) => l.maxW)).toEqual([8, 4]);
    expect(layouts.sm!.map((l) => l.maxW)).toEqual([4, 4]);
    // A stored layout past the edge (the library moves it left) keeps its width
    const past = toGridLayouts([widget(1, [10, 0, 4, 2], [0, 0, 4, 2])]);
    expect(past.lg![0].maxW).toBe(4);
  });

  it('lays out without a change listener', () => {
    const { rerender } = render(<DashboardGrid widgets={widgets.slice(0, 1)} data={data} />);
    rerender(<DashboardGrid widgets={widgets} data={data} />);
    expect(items()).toHaveLength(3);
  });
});

describe('grid layout conversions', () => {
  it('turns widget layouts into the library’s, per breakpoint, keyed by widget id', () => {
    const layouts = toGridLayouts(widgets);
    expect(Object.keys(layouts)).toEqual(['lg', 'md', 'sm']);
    expect(layouts.lg![1]).toEqual({ i: '2', x: 3, y: 0, w: 3, h: 2, maxW: 9 });
    expect(layouts.md![2]).toEqual({ i: '3', x: 0, y: 2, w: 8, h: 5, maxW: 8 });
  });

  it('reads them back, keeping a breakpoint the library did not report', () => {
    const out = fromGridLayouts(widgets, {
      lg: [
        { i: '1', x: 6, y: 1, w: 3, h: 3, minW: 1 },
        { i: '2', x: 0, y: 0, w: 3, h: 2 },
      ],
    });
    expect(out[1]).toEqual({ ...widgets[0].layout, lg: { x: 6, y: 1, w: 3, h: 3 } });
    expect(out[2].lg).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(out[3]).toEqual(widgets[2].layout);
  });
});
