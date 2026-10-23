/**
 * WidgetCard: header (title, resolved period, unit chip; drag handle only
 * while editing), the body by kind, the server's error verbatim, warnings /
 * note / cut period as one muted line, and a loading line before the first
 * data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WidgetCard, TRUNCATED_TEXT } from '../WidgetCard';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeProjectField } from '@/test/factories';
import { resolvedPeriodLabel } from '@/utils/metrics';
import type { DashboardWidget, MetricResult } from '@/types';

vi.mock('../charts/EChart', () => ({
  EChart: ({ kind, label }: { kind: string; label: string }) => <div data-testid="echart" data-kind={kind} aria-label={label} />,
}));

const layout = { lg: { x: 0, y: 0, w: 6, h: 5 }, md: { x: 0, y: 0, w: 8, h: 5 }, sm: { x: 0, y: 0, w: 4, h: 5 } };

const widget = (extra: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id: 1,
  kind: 'bar',
  title: 'Booked weeks per project',
  query: { measure: 'booked_weeks', dimensions: [{ kind: 'project' }] },
  options: {},
  layout,
  sort_order: 0,
  ...extra,
});

const result = (extra: Partial<MetricResult> = {}): MetricResult => ({
  unit: 'weeks',
  dimensions: [{ kind: 'project', label: 'Project' }],
  rows: [{ keys: [{ key: 1, label: 'Alpha' }], value: 3 }],
  total: 3,
  truncated: false,
  warnings: [],
  period: { from: '2026-01-01', to: '2026-12-31' },
  ...extra,
});

beforeEach(() => {
  resetAllStores();
});

describe('WidgetCard', () => {
  it('shows the title, the resolved period and the unit, and draws the chart', () => {
    render(<WidgetCard widget={widget()} result={result()} />);
    expect(screen.getByRole('region', { name: 'Booked weeks per project' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Booked weeks per project' })).toBeInTheDocument();
    expect(screen.getByText(resolvedPeriodLabel({ from: '2026-01-01', to: '2026-12-31' }))).toBeInTheDocument();
    expect(screen.getByText('weeks')).toBeInTheDocument();
    expect(screen.getByTestId('echart')).toHaveAttribute('data-kind', 'bar');
  });

  it.each(['line', 'pie'] as const)('draws a %s chart', (kind) => {
    render(<WidgetCard widget={widget({ kind })} result={result()} />);
    expect(screen.getByTestId('echart')).toHaveAttribute('data-kind', kind);
  });

  it('shows a KPI tile without a unit chip', () => {
    render(<WidgetCard widget={widget({ kind: 'kpi', query: { measure: 'booked_weeks' } })} result={result({ total: 12 })} />);
    expect(screen.getByText('12.0')).toBeInTheDocument();
    // Only the tile's own unit word
    expect(screen.getAllByText('weeks')).toHaveLength(1);
    expect(screen.queryByTestId('echart')).not.toBeInTheDocument();
  });

  it('shows a table with the instance labels of the dimensions', () => {
    useAppStore.setState({
      projectFields: [makeProjectField({ id: 3, name: 'Project type' })],
      instanceSettings: { project_field_labels: '{"customer":"Client"}' },
    });
    const query = { measure: 'booked_weeks' as const, dimensions: [{ kind: 'customer' as const }] };
    render(
      <WidgetCard
        widget={widget({ kind: 'table', query })}
        result={result({ dimensions: [{ kind: 'customer', label: 'Customer' }] })}
      />
    );
    expect(screen.getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
  });

  it('shows the server’s error verbatim, alone', () => {
    render(<WidgetCard widget={widget()} result={{ error: 'This widget needs the Staff view permission' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This widget needs the Staff view permission');
    expect(screen.queryByTestId('echart')).not.toBeInTheDocument();
    // The unit still comes from the query
    expect(screen.getByText('weeks')).toBeInTheDocument();
  });

  it('shows warnings, the note and a cut period as one muted line', () => {
    render(
      <WidgetCard
        widget={widget()}
        result={result({
          warnings: ['Team 14 no longer exists'],
          note: 'A project with several "Tag" items counts in each',
          truncated: true,
        })}
      />
    );
    expect(TRUNCATED_TEXT).toBe('Showing the last five years');
    expect(
      screen.getByText(
        'Team 14 no longer exists · A project with several "Tag" items counts in each · Showing the last five years'
      )
    ).toBeInTheDocument();
  });

  it('says it is loading before the first data, and when there is none', () => {
    const { rerender } = render(<WidgetCard widget={widget()} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    rerender(<WidgetCard widget={widget()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No data yet.');
  });

  it('says when a chart has nothing to show for the period', () => {
    render(<WidgetCard widget={widget()} result={result({ rows: [], total: 0 })} />);
    expect(screen.getByText('Nothing to show for this period.')).toBeInTheDocument();
    expect(screen.queryByTestId('echart')).not.toBeInTheDocument();
  });

  it('shows a percentage unit as %', () => {
    const query = { measure: 'project_count' as const, dimensions: [{ kind: 'site' as const }], percent_of: 'total' as const };
    render(<WidgetCard widget={widget({ query })} />);
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('turns the header into a drag handle only while editing', () => {
    const { container, rerender } = render(<WidgetCard widget={widget()} result={result()} />);
    const header = container.querySelector('.widgetHeader')!;
    expect(header).not.toBeNull();
    expect(header.querySelector('[data-testid="DragIndicatorIcon"]')).toBeNull();
    rerender(<WidgetCard widget={widget()} result={result()} editing />);
    expect(container.querySelector('.widgetHeader [data-testid="DragIndicatorIcon"]')).not.toBeNull();
  });
});
