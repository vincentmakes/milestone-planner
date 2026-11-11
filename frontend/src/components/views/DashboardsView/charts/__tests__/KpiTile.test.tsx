/**
 * KpiTile: the total with its unit, or with `percent_of` the bucket named by
 * `kpi_bucket` — matched on the row key (booleans, ids, numeric strings),
 * never the label — an absent bucket is a share of 0 with "none in this period".
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiTile } from '../KpiTile';
import { kpiValue, BUCKET_NOT_FOUND, OF_TARGET, percentOfTarget, targetBase } from '../kpi';
import type { MetricQuery, MetricResult } from '@/types';

const plain: MetricResult = {
  unit: 'weeks',
  dimensions: [],
  rows: [{ keys: [], value: 123.4 }],
  total: 123.4,
  truncated: false,
  warnings: [],
};

const share: MetricResult = {
  unit: 'percent',
  dimensions: [{ kind: 'confirmed', label: 'Confirmed' }],
  rows: [
    { keys: [{ key: true, label: 'Confirmed' }], value: 62.5 },
    { keys: [{ key: false, label: 'Not confirmed' }], value: 37.5 },
  ],
  total: 100,
  truncated: false,
  warnings: [],
};

const shareQuery: MetricQuery = { measure: 'project_count', dimensions: [{ kind: 'confirmed' }], percent_of: 'total' };

describe('KpiTile', () => {
  it('shows the total and its unit', () => {
    render(<KpiTile result={plain} query={{ measure: 'booked_weeks' }} />);
    expect(screen.getByText('123.4')).toBeInTheDocument();
    expect(screen.getByText('weeks')).toBeInTheDocument();
  });

  it('says "1 phase", "1 person", but "2 people" and "0 phases"', () => {
    const one = (unit: MetricResult['unit'], value: number): MetricResult => ({ ...plain, unit, rows: [{ keys: [], value }], total: value });
    const { rerender } = render(<KpiTile result={one('phases', 1)} query={{ measure: 'phases_due' }} />);
    expect(screen.getByText('phase')).toBeInTheDocument();
    rerender(<KpiTile result={one('people', 1)} query={{ measure: 'people_over_capacity' }} />);
    expect(screen.getByText('person')).toBeInTheDocument();
    rerender(<KpiTile result={one('people', 2)} query={{ measure: 'people_over_capacity' }} />);
    expect(screen.getByText('people')).toBeInTheDocument();
    rerender(<KpiTile result={one('phases', 0)} query={{ measure: 'phases_due' }} />);
    expect(screen.getByText('phases')).toBeInTheDocument();
  });

  it('shows the bucket named by its key, as a percentage without a unit word', () => {
    const { container } = render(<KpiTile result={share} query={shareQuery} options={{ kpi_bucket: true }} />);
    expect(screen.getByText(/^62\.5\s%$/)).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(BUCKET_NOT_FOUND);
  });

  it('shows 0 % when the bucket is missing (the server never zero-fills it), and says so', () => {
    render(<KpiTile result={share} query={shareQuery} options={{ kpi_bucket: 'nope' }} />);
    expect(screen.getByText(/^0\s%$/)).toBeInTheDocument();
    expect(screen.queryByText(/^100\s%$/)).not.toBeInTheDocument();
    expect(screen.getByText(BUCKET_NOT_FOUND)).toBeInTheDocument();
    expect(BUCKET_NOT_FOUND).toBe('none in this period');
  });

  it('shows 0 % for Confirmed when every project is unconfirmed', () => {
    const noneConfirmed: MetricResult = {
      ...share,
      rows: [{ keys: [{ key: false, label: 'Not confirmed' }], value: 100 }],
    };
    expect(kpiValue(noneConfirmed, shareQuery, { kpi_bucket: true })).toEqual({ value: 0, label: null, missing: true });
  });

  it('shows a dash for a total over nothing (null), with no unit word for a percentage', () => {
    const none: MetricResult = { ...plain, unit: 'percent', rows: [{ keys: [], value: null }], total: null };
    const { container } = render(<KpiTile result={none} query={{ measure: 'utilisation' }} />);
    expect(container.querySelector('[class*="number"]')).toHaveTextContent(/^–$/);
    expect(kpiValue(none, { measure: 'utilisation' })).toEqual({ value: null, label: null, missing: false });
  });

  it('hides the unit word when the number is formatted as a percentage', () => {
    render(<KpiTile result={plain} query={{ measure: 'booked_weeks' }} options={{ number_format: 'percent' }} />);
    expect(screen.getByText(/^123\.4\s%$/)).toBeInTheDocument();
    expect(screen.queryByText('weeks')).not.toBeInTheDocument();
  });
});

describe('kpiValue', () => {
  const byItem: MetricResult = {
    ...share,
    rows: [
      { keys: [{ key: 3, label: 'R&D' }], value: 40 },
      { keys: [{ key: 4, label: 'Service' }], value: 60 },
    ],
  };
  const itemQuery: MetricQuery = { measure: 'project_count', dimensions: [{ kind: 'field', field_id: 1 }], percent_of: 'total' };

  it('matches ids given as numbers or numeric strings, never labels', () => {
    expect(kpiValue(byItem, itemQuery, { kpi_bucket: 4 })).toEqual({ value: 60, label: 'Service', missing: false });
    expect(kpiValue(byItem, itemQuery, { kpi_bucket: '3' })).toEqual({ value: 40, label: 'R&D', missing: false });
    expect(kpiValue(byItem, itemQuery, { kpi_bucket: 'Service' }).missing).toBe(true);
  });

  it('is null for a bucket whose rows are all null, and adds the numbers of a mixed one', () => {
    const nulls: MetricResult = {
      ...share,
      rows: [
        { keys: [{ key: 3, label: 'R&D' }], value: null },
        { keys: [{ key: 4, label: 'Service' }], value: null },
        { keys: [{ key: 4, label: 'Service' }], value: 25 },
      ],
    };
    expect(kpiValue(nulls, itemQuery, { kpi_bucket: 3 })).toEqual({ value: null, label: 'R&D', missing: false });
    expect(kpiValue(nulls, itemQuery, { kpi_bucket: 4 }).value).toBe(25);
  });

  it('matches a boolean bucket given as a string', () => {
    expect(kpiValue(share, shareQuery, { kpi_bucket: 'false' }).value).toBe(37.5);
  });

  it('is the total without a percentage or without a bucket', () => {
    expect(kpiValue(share, { ...shareQuery, percent_of: null }, { kpi_bucket: true }).value).toBe(100);
    expect(kpiValue(share, shareQuery, {}).value).toBe(100);
    expect(kpiValue(share, shareQuery, null).missing).toBe(false);
  });
});

describe('KpiTile — % of target (2.6.0)', () => {
  const utilisation = (total: number | null): MetricResult => ({
    unit: 'percent',
    dimensions: [],
    rows: [{ keys: [], value: total }],
    total,
    truncated: false,
    warnings: [],
  });

  it('shows the value as a percentage of the target, the target under it', () => {
    render(<KpiTile result={utilisation(63.7)} query={{ measure: 'utilisation' }} options={{ target: 70, percent_of_target: true }} />);
    expect(screen.getByText(/^91\s%$/)).toBeInTheDocument();
    expect(screen.getByText(OF_TARGET)).toBeInTheDocument();
    expect(screen.getByText(/^Target 70\s%$/)).toBeInTheDocument();
  });

  it('names the target with its unit word, and keeps a missing value as "–"', () => {
    render(<KpiTile result={{ ...plain, total: null }} query={{ measure: 'booked_weeks' }} options={{ target: 20, percent_of_target: true }} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.queryByText(OF_TARGET)).not.toBeInTheDocument();
    expect(screen.getByText('Target 20.0 weeks')).toBeInTheDocument();
  });

  it('ignores the flag without a target above 0', () => {
    render(<KpiTile result={plain} query={{ measure: 'booked_weeks' }} options={{ target: 0, percent_of_target: true }} />);
    expect(screen.getByText('123.4')).toBeInTheDocument();
    expect(screen.queryByText(OF_TARGET)).not.toBeInTheDocument();
  });

  it('computes the base and the percentage', () => {
    expect(targetBase({ target: 70, percent_of_target: true })).toBe(70);
    expect(targetBase({ target: 70 })).toBeNull();
    expect(targetBase({ target: 0, percent_of_target: true })).toBeNull();
    expect(targetBase({ target: -1, percent_of_target: true })).toBeNull();
    expect(targetBase(null)).toBeNull();
    expect(percentOfTarget(35, 70)).toBe(50);
    expect(percentOfTarget(null, 70)).toBeNull();
  });
});
