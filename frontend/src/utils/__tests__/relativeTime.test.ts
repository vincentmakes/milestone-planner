import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeTime } from '../relativeTime';

const NOW = new Date('2026-10-22T12:00:00.000Z').getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

afterEach(() => vi.useRealTimers());

describe('relativeTime', () => {
  it('words the age of a timestamp', () => {
    vi.useFakeTimers({ now: NOW });
    expect(relativeTime(ago(20))).toBe('just now');
    expect(relativeTime(ago(5 * 60))).toBe('5m ago');
    expect(relativeTime(ago(3 * 3600))).toBe('3h ago');
    expect(relativeTime(ago(2 * 86400))).toBe('2d ago');
  });

  it('is empty for a missing or unreadable timestamp', () => {
    expect(relativeTime('not a date')).toBe('');
    expect(relativeTime(null)).toBe('');
  });
});
