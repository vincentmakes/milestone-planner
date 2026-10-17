import { describe, it, expect } from 'vitest';
import { uniqueById } from '../uniqueById';

describe('uniqueById', () => {
  it('keeps the first row of each id, in order', () => {
    const rows = [
      { id: 2, site_id: 1 },
      { id: 1, site_id: 1 },
      { id: 2, site_id: 2 },
    ];
    expect(uniqueById(rows)).toEqual([
      { id: 2, site_id: 1 },
      { id: 1, site_id: 1 },
    ]);
  });

  it('returns an empty list for no rows', () => {
    expect(uniqueById([])).toEqual([]);
  });
});
