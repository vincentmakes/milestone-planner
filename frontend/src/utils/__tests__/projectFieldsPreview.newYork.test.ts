/**
 * The sample project starts on the local day, west of UTC too: at 22:00 in
 * New York it is already the next day in UTC.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi, afterAll } from 'vitest';
import { sampleProject } from '../projectFieldsPreview';

afterAll(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe('sampleProject (America/New_York)', () => {
  it('starts on the local day, not the UTC one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T02:00:00Z')); // 22:00 on March 10 in New York
    const project = sampleProject([], []);
    expect(project.start_date).toBe('2026-03-10');
    expect(project.end_date).toBe('2026-06-07');
  });
});
