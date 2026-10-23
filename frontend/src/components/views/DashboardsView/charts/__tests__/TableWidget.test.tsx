/**
 * TableWidget: first-dimension rows, second-dimension columns, a totals row;
 * sums only for additive measures, the server's total always; missing points
 * empty; instance labels for the dimension headers.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TableWidget } from '../TableWidget';
import type { MetricKey, MetricQuery, MetricResult } from '@/types';

const k = (key: MetricKey['key'], label: string): MetricKey => ({ key, label });
const A = k(1, 'Alpha');
const B = k(2, 'Beta');
const yes = k(true, 'Confirmed');
const no = k(false, 'Not confirmed');

const base = { truncated: false, warnings: [] };

const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('TableWidget', () => {
  it('shows a dimensionless result as one total row', () => {
    const result: MetricResult = { ...base, unit: 'weeks', dimensions: [], rows: [{ keys: [], value: 4 }], total: 4 };
    render(<TableWidget result={result} query={{ measure: 'booked_weeks' }} />);
    expect(screen.getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4.0' })).toBeInTheDocument();
  });

  it('lists one dimension with the unit as header and the server total', () => {
    const result: MetricResult = {
      ...base,
      unit: 'people',
      dimensions: [{ kind: 'team', label: 'Team' }],
      rows: [
        { keys: [A], value: 3 },
        { keys: [B], value: 2 },
      ],
      // A person in both teams counts once in the total
      total: 4,
    };
    render(<TableWidget result={result} query={{ measure: 'people_booked', dimensions: [{ kind: 'team' }] }} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Team', 'people']);
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['3']);
    expect(cells(rows[3])).toEqual(['4']);
  });

  it('sums an additive measure across both dimensions, missing points empty', () => {
    const result: MetricResult = {
      ...base,
      unit: 'weeks',
      dimensions: [
        { kind: 'team', label: 'Team' },
        { kind: 'confirmed', label: 'Confirmed' },
      ],
      rows: [
        { keys: [A, yes], value: 4 },
        { keys: [A, no], value: 1 },
        { keys: [B, yes], value: 2 },
      ],
      total: 7,
    };
    const query: MetricQuery = { measure: 'booked_weeks', dimensions: [{ kind: 'team' }, { kind: 'confirmed' }] };
    render(<TableWidget result={result} query={query} dimensionLabels={['Team', 'Signed']} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Team',
      'Confirmed',
      'Not confirmed',
      'Total',
    ]);
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['4.0', '1.0', '5.0']);
    expect(cells(rows[2])).toEqual(['2.0', '', '2.0']);
    expect(cells(rows[3])).toEqual(['6.0', '1.0', '7.0']);
  });

  it('shows only the server total for distinct counts and percentages', () => {
    const result: MetricResult = {
      ...base,
      unit: 'percent',
      dimensions: [
        { kind: 'team', label: 'Team' },
        { kind: 'confirmed', label: 'Confirmed' },
      ],
      rows: [
        { keys: [A, yes], value: 80 },
        { keys: [A, no], value: 20 },
      ],
      total: 100,
    };
    const query: MetricQuery = {
      measure: 'booked_weeks',
      dimensions: [{ kind: 'team' }, { kind: 'confirmed' }],
      percent_of: 'first_dimension',
    };
    render(<TableWidget result={result} query={query} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Team', 'Confirmed', 'Not confirmed']);
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['80 %', '20 %']);
    const total = cells(rows[2]);
    expect(total).toEqual(['100 %']);
    expect(within(rows[2]).getByRole('cell')).toHaveAttribute('colspan', '2');
  });

  it('puts empty buckets and "Other" last', () => {
    const result: MetricResult = {
      ...base,
      unit: 'projects',
      dimensions: [{ kind: 'customer', label: 'Customer' }],
      rows: [
        { keys: [k('__other__', 'Other')], value: 1 },
        { keys: [k(null, 'No customer')], value: 2 },
        { keys: [k('Acme', 'Acme')], value: 3 },
      ],
      total: 6,
    };
    render(<TableWidget result={result} query={{ measure: 'project_count', dimensions: [{ kind: 'customer' }] }} />);
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Acme', 'No customer', 'Other', 'Total']);
  });
});
