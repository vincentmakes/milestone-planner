import { describe, it, expect } from 'vitest';
import { pixelOfDate } from '../timelinePixels';

const march = Array.from({ length: 31 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}` }));

describe('pixelOfDate', () => {
  it('is 0 without cells', () => {
    expect(pixelOfDate('2026-03-05', [], 30, 'month')).toBe(0);
  });

  it('day cells: the cell index of the day (midnight ISO accepted), past the end the right edge', () => {
    expect(pixelOfDate('2026-03-01', march, 30, 'month')).toBe(0);
    expect(pixelOfDate('2026-03-05T00:00:00.000Z', march, 30, 'week')).toBe(120);
    expect(pixelOfDate('2026-04-02', march, 30, 'month')).toBe(31 * 30);
  });

  it('day cells with hidden weekends: the first cell on or after the day', () => {
    const weekdays = march.filter((_, i) => ![0, 6, 7, 13, 14].includes(i)); // drop Mar 1, 7, 8, 14, 15
    expect(pixelOfDate('2026-03-07', weekdays, 30, 'month')).toBe(pixelOfDate('2026-03-09', weekdays, 30, 'month'));
  });

  it('quarter cells: proportional to the time since the first cell, a hair into the day', () => {
    const weeks = [
      { date: '2026-03-02', dateEnd: '2026-03-08' },
      { date: '2026-03-09', dateEnd: '2026-03-15' },
    ];
    const msPerPx = (14 * 86400000 - 1) / (2 * 70);
    const px = pixelOfDate('2026-03-09', weeks, 70, 'quarter');
    expect(px).toBeGreaterThan(70);
    expect(px).toBeLessThan(70 + 3600000 / msPerPx);
  });

  it('quarter without an end date and year cells use the last cell (or its month) as the end', () => {
    expect(pixelOfDate('2026-03-01', march, 10, 'quarter')).toBeGreaterThan(0);
    const months = [{ date: '2026-01-01' }, { date: '2026-02-01' }, { date: '2026-03-01' }];
    const px = pixelOfDate('2026-02-01', months, 100, 'year');
    // Jan has 31 of the 90 days
    expect(px).toBeCloseTo((31 / 90) * 300, 0);
  });
});
