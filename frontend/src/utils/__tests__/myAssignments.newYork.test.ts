/**
 * My Assignments' upcoming cut-off is the local calendar day: west of UTC a
 * booking ending today stays upcoming in the evening (when the UTC date has
 * already moved on), and midnight-form dates from the server are read as
 * their calendar day.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { collectMyAssignments } from '../myAssignments';
import { formatDateISO } from '../date';
import { makeProject } from '@/test/factories';

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('collectMyAssignments in New York', () => {
  it('keeps a booking that ends today upcoming late in the local evening', () => {
    vi.useFakeTimers();
    // 22:30 in New York on 6 March = 03:30 UTC on 7 March
    vi.setSystemTime(new Date('2026-03-07T03:30:00.000Z'));
    const today = formatDateISO(new Date());
    expect(today).toBe('2026-03-06');
    const project = makeProject({
      staffAssignments: [
        {
          id: 1,
          staff_id: 4,
          allocation: 40,
          start_date: '2026-03-02T00:00:00.000Z',
          end_date: '2026-03-06T00:00:00.000Z',
          approval_status: 'approved',
        },
      ],
    });
    const [row] = collectMyAssignments([project], 4, today);
    expect(row).toMatchObject({ start: '2026-03-02', end: '2026-03-06', upcoming: true });
  });
});
