/**
 * ics.ts is the one parser/generator behind every calendar import and export
 * (vacations, bank holidays, company events). These pin the date semantics:
 * every range comes out inclusive and as YYYY-MM-DD, whatever the file uses.
 */

import { describe, it, expect } from 'vitest';
import {
  parseICS,
  buildICS,
  normalizeICSContent,
  extractDateFromLine,
  unfoldICSLines,
  addDaysISO,
  decodeICSBytes,
  resolveICSDateTime,
  clampText,
  MAX_IMPORT_TEXT_LENGTH,
} from '../ics';

const NOW = new Date(2026, 5, 15); // window: 2025-01-01 .. 2028-12-31

// Fixed local-time offsets so UTC conversion doesn't depend on the machine's TZ
const UTC_PLUS_1 = () => 60;
const UTC_MINUS_5 = () => -300;

const cal = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...events.flat(), 'END:VCALENDAR'].join('\r\n');

const vevent = (...props: string[]) => ['BEGIN:VEVENT', ...props, 'END:VEVENT'];

describe('parseICS - basic events', () => {
  it('reads several events with UID, CATEGORIES and busy status', () => {
    const { events, skipped } = parseICS(
      cal(
        vevent(
          'UID:a@x',
          'DTSTART;VALUE=DATE:20260105',
          'DTEND;VALUE=DATE:20260110',
          'SUMMARY:Ski week',
          'CATEGORIES:Holiday,Family',
          'X-MICROSOFT-CDO-BUSYSTATUS:OOF',
        ),
        vevent('UID:b@x', 'DTSTART;VALUE=DATE:20260301', 'DTEND;VALUE=DATE:20260302', 'SUMMARY:Home office',
          'X-MICROSOFT-CDO-BUSYSTATUS:workingelsewhere'),
      ),
      { now: NOW },
    );

    expect(skipped).toEqual([]);
    expect(events).toEqual([
      {
        uid: 'a@x',
        summary: 'Ski week',
        start_date: '2026-01-05',
        end_date: '2026-01-09',
        categories: ['Holiday', 'Family'],
        busyStatus: 'OOF',
      },
      {
        uid: 'b@x',
        summary: 'Home office',
        start_date: '2026-03-01',
        end_date: '2026-03-01',
        categories: [],
        busyStatus: 'WORKINGELSEWHERE',
      },
    ]);
  });

  it('treats an all-day DTEND as exclusive', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20261231', 'DTEND;VALUE=DATE:20270101', 'SUMMARY:NYE')),
      { now: NOW },
    );
    expect(events[0]).toMatchObject({ start_date: '2026-12-31', end_date: '2026-12-31' });
  });

  it('uses the start date when DTEND is missing', () => {
    const { events } = parseICS(cal(vevent('DTSTART;VALUE=DATE:20260801', 'SUMMARY:National Day')), { now: NOW });
    expect(events[0]).toMatchObject({ start_date: '2026-08-01', end_date: '2026-08-01' });
  });

  it('honours DURATION when there is no DTEND', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20260801', 'DURATION:P3D', 'SUMMARY:Long weekend')),
      { now: NOW },
    );
    expect(events[0]).toMatchObject({ start_date: '2026-08-01', end_date: '2026-08-03' });
  });

  it('takes the date part of DATE-TIME values (UTC, floating and TZID)', () => {
    const { events } = parseICS(
      cal(
        vevent('DTSTART:20260310T090000Z', 'DTEND:20260312T170000Z', 'SUMMARY:UTC'),
        vevent('DTSTART;TZID="Europe/Zurich":20260410T080000', 'DTEND;TZID="Europe/Zurich":20260410T120000', 'SUMMARY:TZID'),
        vevent('DTSTART:20260510T000000', 'DTEND:20260512T000000', 'SUMMARY:Midnight end'),
      ),
      { now: NOW, utcOffset: UTC_PLUS_1 },
    );
    expect(events.map((e) => [e.summary, e.start_date, e.end_date])).toEqual([
      ['UTC', '2026-03-10', '2026-03-12'],
      ['TZID', '2026-04-10', '2026-04-10'],
      // Ends at 00:00 on the 12th, so the 12th itself is not occupied.
      ['Midnight end', '2026-05-10', '2026-05-11'],
    ]);
  });

  it('unfolds continuation lines', () => {
    const content = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260601',
      'SUMMARY:A very long summary that was',
      '  folded by the exporter',
      'DESCRIPTION:line one\\nline',
      '\t two',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const { events } = parseICS(content, { now: NOW });
    expect(events[0].summary).toBe('A very long summary that was folded by the exporter');
    expect(events[0].description).toBe('line one\nline two');
  });

  it('ignores properties of nested components such as VALARM', () => {
    const { events } = parseICS(
      cal(
        vevent(
          'DTSTART;VALUE=DATE:20260601',
          'SUMMARY:Real',
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          'DESCRIPTION:Reminder',
          'END:VALARM',
        ),
      ),
      { now: NOW },
    );
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Real');
    expect(events[0].description).toBeUndefined();
  });

  it('reports events without a start date and cancelled events as skipped', () => {
    const { events, skipped } = parseICS(
      cal(
        vevent('SUMMARY:No date'),
        vevent('DTSTART;VALUE=DATE:20260601', 'SUMMARY:Called off', 'STATUS:CANCELLED'),
      ),
      { now: NOW },
    );
    expect(events).toEqual([]);
    expect(skipped).toEqual([
      { summary: 'No date', reason: 'missing date' },
      { summary: 'Called off', reason: 'cancelled' },
    ]);
  });
});

describe('parseICS - encodings', () => {
  it('handles a UTF-8 BOM', () => {
    const { events } = parseICS('\uFEFF' + cal(vevent('DTSTART;VALUE=DATE:20260601', 'SUMMARY:BOM')), { now: NOW });
    expect(events[0].summary).toBe('BOM');
  });

  it('handles UTF-16 content read as text (NUL between characters)', () => {
    const text = cal(vevent('DTSTART;VALUE=DATE:20260601', 'SUMMARY:SAP'));
    const utf16ish = '\uFFFE' + text.split('').map((c) => c + String.fromCharCode(0)).join('');
    expect(normalizeICSContent(utf16ish)).toBe(text);
    const { events } = parseICS(utf16ish, { now: NOW });
    expect(events[0]).toMatchObject({ summary: 'SAP', start_date: '2026-06-01' });
  });

  it('decodes UTF-16 LE/BE bytes with or without a BOM, and UTF-8', () => {
    const text = cal(vevent('DTSTART;VALUE=DATE:20260601', 'SUMMARY:Fête nationale'));
    const le = (s: string, bom: boolean) => {
      const out = bom ? [0xff, 0xfe] : [];
      for (const ch of s) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
      return new Uint8Array(out).buffer;
    };
    const be = (s: string) => {
      const out = [0xfe, 0xff];
      for (const ch of s) out.push(ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff);
      return new Uint8Array(out).buffer;
    };
    const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]).buffer;

    for (const buffer of [le(text, true), le(text, false), be(text), utf8bom]) {
      expect(decodeICSBytes(buffer)).toBe(text);
    }
    expect(parseICS(decodeICSBytes(le(text, true)), { now: NOW }).events[0].summary).toBe('Fête nationale');
  });
});

describe('parseICS - recurrence', () => {
  it('expands a yearly rule from the start up to current year + 2', () => {
    const { events, skipped } = parseICS(
      cal(vevent('UID:ny', 'DTSTART;VALUE=DATE:20250101', 'DTEND;VALUE=DATE:20250102', 'RRULE:FREQ=YEARLY', 'SUMMARY:New Year')),
      { now: NOW },
    );
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.start_date)).toEqual(['2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01']);
    expect(events.every((e) => e.recurrence === 'yearly' && e.uid === 'ny' && e.start_date === e.end_date)).toBe(true);
  });

  it('never starts earlier than Jan 1 of current year - 1', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20100801', 'RRULE:FREQ=YEARLY', 'SUMMARY:National Day')),
      { now: NOW },
    );
    expect(events.map((e) => e.start_date)).toEqual(['2025-08-01', '2026-08-01', '2027-08-01', '2028-08-01']);
  });

  it('keeps the span of multi-day occurrences', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227', 'RRULE:FREQ=YEARLY', 'SUMMARY:Xmas')),
      { now: NOW },
    );
    expect(events.map((e) => [e.start_date, e.end_date])).toEqual([
      ['2026-12-24', '2026-12-26'],
      ['2027-12-24', '2027-12-26'],
      ['2028-12-24', '2028-12-26'],
    ]);
  });

  it('respects COUNT (counted from the series start)', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20240501', 'RRULE:FREQ=YEARLY;COUNT=3', 'SUMMARY:Labour Day')),
      { now: NOW },
    );
    // 2024 (outside window), 2025, 2026 -- then the count is exhausted.
    expect(events.map((e) => e.start_date)).toEqual(['2025-05-01', '2026-05-01']);
  });

  it('respects UNTIL', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20250501', 'RRULE:FREQ=YEARLY;UNTIL=20270501T000000Z', 'SUMMARY:Labour Day')),
      { now: NOW },
    );
    expect(events.map((e) => e.start_date)).toEqual(['2025-05-01', '2026-05-01', '2027-05-01']);
  });

  it('applies EXDATE and RECURRENCE-ID overrides', () => {
    const { events } = parseICS(
      cal(
        vevent('UID:s', 'DTSTART;VALUE=DATE:20250301', 'RRULE:FREQ=YEARLY', 'EXDATE;VALUE=DATE:20260301', 'SUMMARY:Spring'),
        vevent('UID:s', 'RECURRENCE-ID;VALUE=DATE:20270301', 'DTSTART;VALUE=DATE:20270302', 'SUMMARY:Spring (moved)'),
      ),
      { now: NOW },
    );
    expect(events.map((e) => [e.summary, e.start_date])).toEqual([
      ['Spring', '2025-03-01'],
      ['Spring (moved)', '2027-03-02'],
      ['Spring', '2028-03-01'],
    ]);
  });

  it('skips Feb 29 in non-leap years', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY', 'SUMMARY:Leap')),
      { now: NOW },
    );
    expect(events.map((e) => e.start_date)).toEqual(['2028-02-29']);
  });

  it('reports other recurrences as skipped instead of importing one occurrence', () => {
    const { events, skipped } = parseICS(
      cal(
        vevent('DTSTART;VALUE=DATE:20260105', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Weekly'),
        vevent('DTSTART;VALUE=DATE:20261126', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'SUMMARY:Thanksgiving'),
        vevent('DTSTART;VALUE=DATE:20260601', 'SUMMARY:Plain'),
      ),
      { now: NOW },
    );
    expect(events.map((e) => e.summary)).toEqual(['Plain']);
    expect(skipped).toEqual([
      { summary: 'Weekly', reason: 'unsupported recurrence' },
      { summary: 'Thanksgiving', reason: 'unsupported recurrence' },
    ]);
  });
});

describe('buildICS', () => {
  it('writes all-day events with an exclusive DTEND and CRLF line endings', () => {
    const ics = buildICS(
      [
        { uid: 'h-1@milestone', summary: 'Christmas', start_date: '2026-12-25', end_date: '2026-12-26', transparency: 'TRANSPARENT' },
        { summary: 'Single', start_date: '2026-12-31' },
      ],
      'Bank Holidays',
    );
    const lines = ics.split('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('PRODID:-//Milestone//Bank Holidays//EN');
    expect(lines).toContain('UID:h-1@milestone');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261225');
    expect(lines).toContain('DTEND;VALUE=DATE:20261227');
    expect(lines).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines).toContain('TRANSP:TRANSPARENT');
    expect(lines).toContain('TRANSP:OPAQUE');
  });

  it('round-trips escaped text, busy status and long lines through parseICS', () => {
    const summary = 'Team; offsite, "Zürich" \\ day\nsecond line ' + 'x'.repeat(120);
    const ics = buildICS(
      [{ summary, description: 'a,b;c', start_date: '2026-09-01', end_date: '2026-09-03', busyStatus: 'OOF' }],
      'Vacation Export',
    );
    // Every physical line is at most 75 octets.
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const { events } = parseICS(ics, { now: NOW });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      summary,
      description: 'a,b;c',
      start_date: '2026-09-01',
      end_date: '2026-09-03',
      busyStatus: 'OOF',
    });
  });
});

describe('helpers', () => {
  it('extractDateFromLine reads DATE and DATE-TIME lines', () => {
    expect(extractDateFromLine('DTSTART;VALUE=DATE:20260101')).toBe('2026-01-01');
    expect(extractDateFromLine('DTEND:20260102T120000Z')).toBe('2026-01-02');
    expect(extractDateFromLine('DTSTART;TZID="America/New_York":20260103T090000')).toBe('2026-01-03');
    expect(extractDateFromLine('SUMMARY:nothing')).toBeNull();
  });

  it('unfoldICSLines joins space- and tab-continued lines', () => {
    expect(unfoldICSLines('A:1\r\n 2\r\n\t3\nB:4')).toEqual(['A:123', 'B:4']);
  });

  it('addDaysISO crosses month and year boundaries', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('UTC DATE-TIME values use the local calendar date', () => {
  it('resolveICSDateTime converts a trailing-Z value with the given offset', () => {
    expect(resolveICSDateTime('20240101T230000Z', UTC_PLUS_1)).toEqual({
      date: '2024-01-02',
      isMidnight: true,
    });
    expect(resolveICSDateTime('20240101T230000Z', () => 0)).toEqual({
      date: '2024-01-01',
      isMidnight: false,
    });
    expect(resolveICSDateTime('20240102T030000Z', UTC_MINUS_5)).toEqual({
      date: '2024-01-01',
      isMidnight: false,
    });
  });

  it('keeps DATE, floating and TZID values as written', () => {
    expect(resolveICSDateTime('20240101', UTC_PLUS_1)).toEqual({ date: '2024-01-01', isMidnight: false });
    expect(resolveICSDateTime('20240101T230000', UTC_PLUS_1)).toEqual({ date: '2024-01-01', isMidnight: false });
    expect(resolveICSDateTime('20240102T000000', UTC_PLUS_1)).toEqual({ date: '2024-01-02', isMidnight: true });
    expect(resolveICSDateTime('nonsense', UTC_PLUS_1)).toBeNull();
  });

  it('an evening UTC event lands on the next local day in a positive-offset zone', () => {
    const { events } = parseICS(
      cal(vevent('DTSTART:20240101T230000Z', 'DTEND:20240102T010000Z', 'SUMMARY:Late')),
      { now: new Date(2024, 5, 1), utcOffset: UTC_PLUS_1 },
    );
    expect(events[0]).toMatchObject({ start_date: '2024-01-02', end_date: '2024-01-02' });
  });

  it('applies the exclusive midnight end on the local clock', () => {
    // 2024-01-03T23:00Z is 00:00 on Jan 4 in UTC+1: Jan 4 is not occupied.
    const { events } = parseICS(
      cal(vevent('DTSTART:20240101T230000Z', 'DTEND:20240103T230000Z', 'SUMMARY:Two days')),
      { now: new Date(2024, 5, 1), utcOffset: UTC_PLUS_1 },
    );
    expect(events[0]).toMatchObject({ start_date: '2024-01-02', end_date: '2024-01-03' });
  });

  it('TZID and floating values are not shifted', () => {
    const { events } = parseICS(
      cal(
        vevent('DTSTART;TZID=Europe/Zurich:20240101T230000', 'DTEND;TZID=Europe/Zurich:20240101T233000', 'SUMMARY:TZID'),
        vevent('DTSTART:20240101T230000', 'SUMMARY:Floating'),
      ),
      { now: new Date(2024, 5, 1), utcOffset: UTC_PLUS_1 },
    );
    expect(events.map((e) => [e.summary, e.start_date, e.end_date])).toEqual([
      ['TZID', '2024-01-01', '2024-01-01'],
      ['Floating', '2024-01-01', '2024-01-01'],
    ]);
  });
});

describe('clampText', () => {
  it('trims and leaves short text alone', () => {
    expect(clampText('  Christmas  ')).toBe('Christmas');
  });

  it('cuts long text to the limit, ending with an ellipsis', () => {
    const long = 'x'.repeat(250);
    const out = clampText(long);
    expect(out).toHaveLength(MAX_IMPORT_TEXT_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    expect(clampText('abcdefgh', 5)).toBe('abcd…');
  });

  it('keeps text exactly at the limit unchanged', () => {
    const exact = 'y'.repeat(MAX_IMPORT_TEXT_LENGTH);
    expect(clampText(exact)).toBe(exact);
  });

  it('does not split surrogate pairs', () => {
    expect(clampText('😀😀😀😀😀😀', 4)).toBe('😀😀😀…');
  });
});
