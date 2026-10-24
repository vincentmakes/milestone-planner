/**
 * EChart over a fake `echarts/core`: one init per mount with the registered
 * `milestone` theme, the option set with notMerge on every result change, a
 * resize on every container resize, dispose on unmount, and a re-theme
 * (register + setTheme) when `<html data-theme>` changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { MetricResult } from '@/types';

const fake = vi.hoisted(() => {
  const instance = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    setTheme: vi.fn(),
    getOption: vi.fn(),
  };
  return {
    instance,
    init: vi.fn(() => instance),
    use: vi.fn(),
    registerTheme: vi.fn(),
  };
});

vi.mock('echarts/core', () => ({ init: fake.init, use: fake.use, registerTheme: fake.registerTheme }));
// Every named import of EChart.tsx must exist here: vitest throws on a missing one.
vi.mock('echarts/charts', () => ({
  BarChart: 'BarChart',
  LineChart: 'LineChart',
  PieChart: 'PieChart',
  GaugeChart: 'GaugeChart',
  HeatmapChart: 'HeatmapChart',
  TreemapChart: 'TreemapChart',
  SankeyChart: 'SankeyChart',
}));
vi.mock('echarts/components', () => ({
  AriaComponent: 'AriaComponent',
  DatasetComponent: 'DatasetComponent',
  GridComponent: 'GridComponent',
  LegendComponent: 'LegendComponent',
  TooltipComponent: 'TooltipComponent',
  VisualMapComponent: 'VisualMapComponent',
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: 'CanvasRenderer' }));

import { EChart } from '../EChart';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

const result = (value: number): MetricResult => ({
  unit: 'weeks',
  dimensions: [{ kind: 'team', label: 'Team' }],
  rows: [{ keys: [{ key: 1, label: 'Alpha' }], value }],
  total: value,
  truncated: false,
  warnings: [],
});

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  for (const fn of Object.values(fake.instance)) fn.mockClear();
  fake.init.mockClear();
  fake.registerTheme.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('EChart', () => {
  it('registers the chart parts once, at module load', () => {
    expect(fake.use).toHaveBeenCalledTimes(1);
    expect(fake.use.mock.calls[0][0]).toEqual([
      'BarChart',
      'LineChart',
      'PieChart',
      'GaugeChart',
      'HeatmapChart',
      'TreemapChart',
      'SankeyChart',
      'GridComponent',
      'TooltipComponent',
      'LegendComponent',
      'VisualMapComponent',
      'DatasetComponent',
      'AriaComponent',
      'CanvasRenderer',
    ]);
  });

  it('initialises once with the milestone theme and sets the option', () => {
    render(<EChart kind="bar" result={result(3)} label="Booked weeks" />);
    const container = screen.getByRole('img', { name: 'Booked weeks' });
    expect(fake.registerTheme).toHaveBeenCalledWith('milestone', expect.objectContaining({ color: expect.any(Array) }));
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.init).toHaveBeenCalledWith(container, 'milestone', { renderer: 'canvas' });
    expect(fake.instance.setOption).toHaveBeenCalledTimes(1);
    const [option, opts] = fake.instance.setOption.mock.calls[0];
    expect(opts).toEqual({ notMerge: true });
    expect(option.series[0].data).toEqual([3]);
  });

  it('sets the new option when the result changes, without a new instance', () => {
    const { rerender } = render(<EChart kind="bar" result={result(3)} label="W" />);
    rerender(<EChart kind="bar" result={result(8)} label="W" />);
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(2);
    expect(fake.instance.setOption.mock.calls[1][0].series[0].data).toEqual([8]);
  });

  it('resizes with its container', () => {
    render(<EChart kind="line" result={result(3)} label="W" />);
    const [observer] = FakeResizeObserver.instances;
    expect(observer.observed).toEqual([screen.getByRole('img', { name: 'W' })]);
    observer.callback([], observer as unknown as ResizeObserver);
    expect(fake.instance.resize).toHaveBeenCalledTimes(1);
  });

  it('tilts and shortens the labels when its container is narrow for its categories', () => {
    const three: MetricResult = {
      ...result(3),
      rows: [1, 2, 3].map((key) => ({ keys: [{ key, label: `Team ${key}` }], value: key })),
    };
    const { rerender } = render(<EChart kind="bar" result={result(3)} label="W" />);
    const [observer] = FakeResizeObserver.instances;
    const resizeTo = (width: number) =>
      act(() => observer.callback([{ contentRect: { width } } as ResizeObserverEntry], observer as unknown as ResizeObserver));
    expect(fake.instance.setOption.mock.calls[0][0].xAxis.axisLabel.rotate).toBeUndefined();
    // One category in 60 px: narrow → the option is set again with tilted, shorter labels
    resizeTo(60);
    expect(fake.instance.resize).toHaveBeenCalledTimes(1);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(2);
    expect(fake.instance.setOption.mock.calls[1][0].xAxis.axisLabel).toMatchObject({ rotate: 30, width: 72 });
    // Wide again: level labels; a resize that stays wide sets nothing new
    resizeTo(400);
    expect(fake.instance.setOption.mock.calls[2][0].xAxis.axisLabel.rotate).toBeUndefined();
    resizeTo(420);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(3);
    // Three categories in the same 420 px: 140 px each, still level…
    rerender(<EChart kind="bar" result={three} label="W" />);
    expect(fake.instance.setOption.mock.calls[3][0].xAxis.axisLabel.rotate).toBeUndefined();
    // …but in 240 px they are (80 px each)
    resizeTo(240);
    expect(fake.instance.setOption.mock.calls[4][0].xAxis.axisLabel.rotate).toBe(30);
  });

  it('measures the container when the observer gives no entry', () => {
    render(<EChart kind="bar" result={result(3)} label="W" />);
    const [observer] = FakeResizeObserver.instances;
    const node = screen.getByRole('img', { name: 'W' });
    Object.defineProperty(node, 'clientWidth', { configurable: true, value: 50 });
    act(() => observer.callback([], observer as unknown as ResizeObserver));
    expect(fake.instance.setOption.mock.calls[1][0].xAxis.axisLabel.rotate).toBe(30);
  });

  it('keeps the container height too: a heatmap shows its values once every cell has room', () => {
    const heatmap: MetricResult = {
      unit: 'weeks',
      dimensions: [
        { kind: 'team', label: 'Team' },
        { kind: 'period', label: 'Month' },
      ],
      rows: [1, 2].flatMap((team) =>
        ['2026-01', '2026-02'].map((month) => ({
          keys: [
            { key: team, label: `Team ${team}` },
            { key: month, label: month },
          ],
          value: team,
        }))
      ),
      total: 6,
      truncated: false,
      warnings: [],
    };
    render(<EChart kind="heatmap" result={heatmap} label="H" />);
    const [observer] = FakeResizeObserver.instances;
    const resizeTo = (width: number, height: number) =>
      act(() =>
        observer.callback([{ contentRect: { width, height } } as ResizeObserverEntry], observer as unknown as ResizeObserver)
      );
    const last = () => fake.instance.setOption.mock.calls[fake.instance.setOption.mock.calls.length - 1][0];
    // Unmeasured: no values in the cells
    expect(last().series[0].label.show).toBe(false);
    // 2 × 2 cells in 200 × 100 px: 100 px wide, 50 px high each
    resizeTo(200, 100);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(2);
    expect(last().series[0].label.show).toBe(true);
    expect(last().xAxis.axisLabel.rotate).toBeUndefined();
    // A resize that keeps them fitting sets nothing new
    resizeTo(210, 110);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(2);
    // 15 px high rows: no room
    resizeTo(210, 30);
    expect(fake.instance.setOption).toHaveBeenCalledTimes(3);
    expect(last().series[0].label.show).toBe(false);
    // 60 px columns: narrow (tilted labels), values still fit
    resizeTo(120, 100);
    expect(last().series[0].label.show).toBe(true);
    expect(last().xAxis.axisLabel.rotate).toBe(30);
    // No entry: the container's own size
    const node = screen.getByRole('img', { name: 'H' });
    Object.defineProperty(node, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 20 });
    act(() => observer.callback([], observer as unknown as ResizeObserver));
    expect(last().series[0].label.show).toBe(false);
    expect(last().xAxis.axisLabel.rotate).toBeUndefined();
  });

  it('never shows heatmap values on another kind', () => {
    render(<EChart kind="bar" result={result(3)} label="W" />);
    const [observer] = FakeResizeObserver.instances;
    act(() =>
      observer.callback([{ contentRect: { width: 400, height: 400 } } as ResizeObserverEntry], observer as unknown as ResizeObserver)
    );
    // Wide and tall, but a bar: the option is not set again
    expect(fake.instance.setOption).toHaveBeenCalledTimes(1);
  });

  it('disposes the chart and stops observing on unmount', () => {
    const { unmount } = render(<EChart kind="pie" result={result(3)} label="W" />);
    unmount();
    expect(fake.instance.dispose).toHaveBeenCalledTimes(1);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });

  it('re-themes from the new tokens when data-theme changes', async () => {
    render(<EChart kind="bar" result={result(3)} label="W" />);
    expect(fake.instance.setTheme).not.toHaveBeenCalled();
    document.documentElement.style.setProperty('--accent-blue', '#0000ff');
    try {
      await act(async () => {
        document.documentElement.setAttribute('data-theme', 'light');
        await Promise.resolve();
      });
      expect(fake.registerTheme).toHaveBeenCalledTimes(2);
      expect(fake.registerTheme.mock.calls[1][1].color[0]).toBe('#0000ff');
      expect(fake.instance.setTheme).toHaveBeenCalledWith('milestone');
      // The option is rebuilt with the new palette
      expect(fake.instance.setOption).toHaveBeenCalledTimes(2);
      expect(fake.instance.setOption.mock.calls[1][0].series[0].itemStyle.color).toBe('#0000ff');
      expect(fake.init).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.style.removeProperty('--accent-blue');
    }
  });
});
