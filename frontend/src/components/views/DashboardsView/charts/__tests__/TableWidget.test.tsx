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

  it('leaves the row and column sums out when a fact counted in several values', () => {
    // One 100 % booking Mon–Fri on project P tagged A and B: both cells hold
    // it, the distinct total is 1 week — a row sum would say 2.
    const P = k(7, 'Project P');
    const result: MetricResult = {
      ...base,
      unit: 'weeks',
      dimensions: [
        { kind: 'project', label: 'Project' },
        { kind: 'tag', label: 'Tag' },
      ],
      rows: [
        { keys: [P, k(1, 'Tag A')], value: 1 },
        { keys: [P, k(2, 'Tag B')], value: 1 },
      ],
      total: 1,
      note: 'A booking counts in each of its tags',
    };
    const query: MetricQuery = { measure: 'booked_weeks', dimensions: [{ kind: 'project' }, { kind: 'tag' }] };
    render(<TableWidget result={result} query={query} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Project', 'Tag A', 'Tag B']);
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['1.0', '1.0']);
    expect(cells(rows[2])).toEqual(['1.0']);
    expect(within(rows[2]).getByRole('cell')).toHaveAttribute('colspan', '2');
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
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

  it('shows a dash for a value over nothing (null), one dimension or two, and for a null total', () => {
    const result: MetricResult = {
      ...base,
      unit: 'percent',
      dimensions: [{ kind: 'person', label: 'Person' }],
      rows: [
        { keys: [A], value: null },
        { keys: [B], value: 120 },
      ],
      total: null,
    };
    render(<TableWidget result={result} query={{ measure: 'utilisation', dimensions: [{ kind: 'person' }] }} />);
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['–']);
    expect(cells(rows[2])[0]).toMatch(/^120\s%$/);
    expect(cells(rows[3])).toEqual(['–']);
  });

  it('keeps a null cell "–" beside a missing (empty) one in a cross table, and sums capacity days', () => {
    const result: MetricResult = {
      ...base,
      unit: 'days',
      dimensions: [
        { kind: 'team', label: 'Team' },
        { kind: 'confirmed', label: 'Confirmed' },
      ],
      rows: [
        { keys: [A, yes], value: null },
        { keys: [A, no], value: 4 },
        { keys: [B, yes], value: 2 },
        { keys: [B, yes], value: null },
      ],
      total: 6,
    };
    render(
      <TableWidget
        result={result}
        query={{ measure: 'capacity_days', dimensions: [{ kind: 'team' }, { kind: 'confirmed' }] }}
      />
    );
    const rows = screen.getAllByRole('row');
    expect(cells(rows[1])).toEqual(['–', '4.0', '4.0']);
    expect(cells(rows[2])).toEqual(['2.0', '', '2.0']);
    expect(cells(rows[3])).toEqual(['2.0', '4.0', '6.0']);
  });

  it('never sums the rows of a calculation, and heads a number "Value" and a percentage "%"', () => {
    const rows = [
      { keys: [A, yes], value: 0.5 },
      { keys: [B, yes], value: 0.25 },
    ];
    const result: MetricResult = {
      ...base,
      unit: 'number',
      dimensions: [
        { kind: 'team', label: 'Team' },
        { kind: 'confirmed', label: 'Confirmed' },
      ],
      rows,
      total: 0.4,
    };
    const query: MetricQuery = {
      measure: 'booked_weeks',
      dimensions: [{ kind: 'team' }, { kind: 'confirmed' }],
      formula: { expression: 'a / b', terms: [{ name: 'a', measure: 'booked_weeks' }, { name: 'b', measure: 'capacity_weeks' }], result: 'number' },
    };
    const { unmount } = render(<TableWidget result={result} query={query} />);
    // No row or column sums; the total row holds the server's total only.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Team', 'Confirmed']);
    expect(screen.getByText('0.40')).toBeInTheDocument();
    unmount();
    const one = { ...result, dimensions: [{ kind: 'team' as const, label: 'Team' }], rows: [{ keys: [A], value: 0.5 }] };
    const { unmount: unmountOne } = render(<TableWidget result={one} query={{ ...query, dimensions: [{ kind: 'team' }] }} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Team', 'Value']);
    unmountOne();
    render(<TableWidget result={{ ...one, unit: 'percent' }} query={{ ...query, dimensions: [{ kind: 'team' }] }} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Team', '%']);
  });

  it('sums capacity weeks like capacity days', () => {
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
      ],
      total: 5,
    };
    render(<TableWidget result={result} query={{ measure: 'capacity_weeks', dimensions: [{ kind: 'team' }, { kind: 'confirmed' }] }} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Total');
  });
});
