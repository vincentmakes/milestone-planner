/**
 * KpiTile: the total with its unit, or with `percent_of` the bucket named by
 * `kpi_bucket` — matched on the row key (booleans, ids, numeric strings),
 * never the label — falling back to the total with "bucket not found".
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiTile } from '../KpiTile';
import { kpiValue, BUCKET_NOT_FOUND } from '../kpi';
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

  it('shows the bucket named by its key, as a percentage without a unit word', () => {
    const { container } = render(<KpiTile result={share} query={shareQuery} options={{ kpi_bucket: true }} />);
    expect(screen.getByText(/^62\.5\s%$/)).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(BUCKET_NOT_FOUND);
  });

  it('falls back to the total when the bucket is missing, and says so', () => {
    render(<KpiTile result={share} query={shareQuery} options={{ kpi_bucket: 'nope' }} />);
    expect(screen.getByText(/^100\s%$/)).toBeInTheDocument();
    expect(screen.getByText(BUCKET_NOT_FOUND)).toBeInTheDocument();
    expect(BUCKET_NOT_FOUND).toBe('bucket not found');
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

  it('matches a boolean bucket given as a string', () => {
    expect(kpiValue(share, shareQuery, { kpi_bucket: 'false' }).value).toBe(37.5);
  });

  it('is the total without a percentage or without a bucket', () => {
    expect(kpiValue(share, { ...shareQuery, percent_of: null }, { kpi_bucket: true }).value).toBe(100);
    expect(kpiValue(share, shareQuery, {}).value).toBe(100);
    expect(kpiValue(share, shareQuery, null).missing).toBe(false);
  });
});
