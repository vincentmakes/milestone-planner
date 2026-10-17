/**
 * iCalendar (.ics) parsing and generation.
 *
 * One parser and one generator for every calendar import/export in the app
 * (vacations, bank holidays, company events). Only all-day semantics matter
 * here: every value is reduced to a `YYYY-MM-DD` date, and every range is
 * inclusive on both ends, matching how the rest of the frontend stores dates.
 *
 * RFC 5545 details handled:
 * - line unfolding (continuation lines start with a space or a tab)
 * - DATE and DATE-TIME values: floating and `TZID` values keep the date as
 *   written; UTC values (trailing `Z`) are converted to the browser's local
 *   calendar date, so `20240101T230000Z` is Jan 2 in UTC+1
 * - clampText() cuts imported names to the length the backend accepts
 * - exclusive all-day DTEND (minus one day), missing DTEND (same day), DURATION
 * - escaped text (`\\`, `\;`, `\,`, `\n`)
 * - several VEVENTs per file, nested components (VALARM) ignored
 * - `RRULE:FREQ=YEARLY` (COUNT / UNTIL / INTERVAL / EXDATE / RECURRENCE-ID),
 *   which public-holiday feeds use; any other recurrence is reported as
 *   skipped rather than silently imported as a single occurrence
 * - UTF-16 / BOM content (SAP exports)
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ParsedICSEvent {
  uid?: string;
  summary: string;
  description?: string;
  /** First day, `YYYY-MM-DD` */
  start_date: string;
  /** Last day, inclusive, `YYYY-MM-DD` */
  end_date: string;
  categories: string[];
  /** Value of X-MICROSOFT-CDO-BUSYSTATUS (e.g. OOF, BUSY, WORKINGELSEWHERE) */
  busyStatus?: string;
  /** Set when this event is one occurrence of an expanded yearly series */
  recurrence?: 'yearly';
}

export type ICSSkipReason = 'unsupported recurrence' | 'missing date' | 'cancelled';

export interface SkippedICSEvent {
  summary: string;
  reason: ICSSkipReason;
}

export interface ParsedICS {
  events: ParsedICSEvent[];
  skipped: SkippedICSEvent[];
}

/** Minutes local time is ahead of UTC at a given instant (UTC+1 → 60). */
export type UTCOffsetFn = (instant: Date) => number;

export interface ParseICSOptions {
  /** Reference "now" for the yearly-expansion window (defaults to today). */
  now?: Date;
  /**
   * Local-time offset used to turn UTC (`...Z`) DATE-TIME values into local
   * calendar dates. Defaults to the browser's time zone; injectable for tests.
   */
  utcOffset?: UTCOffsetFn;
}

/** Event shape accepted by buildICS. */
export interface ICSExportEvent {
  uid?: string;
  summary: string;
  /** First day, `YYYY-MM-DD` (a longer ISO string is truncated) */
  start_date: string;
  /** Last day, inclusive, `YYYY-MM-DD`; defaults to start_date */
  end_date?: string | null;
  description?: string;
  /** Written as X-MICROSOFT-CDO-BUSYSTATUS (e.g. OOF for Outlook out-of-office) */
  busyStatus?: string;
  /** TRANSPARENT = does not block time (holidays, events). Default OPAQUE. */
  transparency?: 'OPAQUE' | 'TRANSPARENT';
}

// =============================================================================
// LOW-LEVEL HELPERS
// =============================================================================

/** Longest name/description the backend accepts for imported items. */
export const MAX_IMPORT_TEXT_LENGTH = 200;

/**
 * Trim `text` and cut it to at most `max` characters, ending with "…" when it
 * was shortened (the ellipsis counts towards the limit). Keeps one overly long
 * SUMMARY from making the backend reject a whole import with a 422.
 */
export function clampText(text: string, max: number = MAX_IMPORT_TEXT_LENGTH): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed); // don't split surrogate pairs
  if (chars.length <= max) return trimmed;
  if (max <= 1) return chars.slice(0, max).join('');
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

const NUL = String.fromCharCode(0);

/**
 * Normalize ICS content - handles UTF-16 encoding (SAP exports) and BOMs.
 */
export function normalizeICSContent(content: string): string {
  // UTF-16 read as UTF-8 leaves a NUL byte between ASCII characters.
  if (content.includes(NUL) || content.charCodeAt(1) === 0) {
    content = content.split(NUL).join('');
  }

  // Also handle any BOM (Byte Order Mark)
  return content.replace(/^\uFEFF/, '').replace(/^\uFFFE/, '');
}

/**
 * Decode raw .ics bytes. Honours UTF-16 LE/BE (with or without a BOM, as SAP
 * and some Outlook exports produce) and falls back to UTF-8.
 */
export function decodeICSBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) encoding = 'utf-16le';
  else if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] !== 0) encoding = 'utf-16be';
  return normalizeICSContent(new TextDecoder(encoding).decode(bytes));
}

/** Read a user-selected .ics File as text (see decodeICSBytes). */
export function readICSFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(decodeICSBytes(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Split content into logical lines, joining RFC 5545 folded lines
 * (a CRLF followed by a single space or tab continues the previous line).
 */
export function unfoldICSLines(content: string): string[] {
  return content
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

/** Unescape an ICS TEXT value. */
export function unescapeICSText(text: string): string {
  return text.replace(/\\([\\;,nN])/g, (_, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n';
    return ch;
  });
}

/** Escape a string for an ICS TEXT value. */
export function escapeICSText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Parse `NAME;PARAM=VAL;PARAM2="quoted:val":value` into its parts.
 * The value starts at the first colon outside a quoted parameter value.
 */
function parseContentLine(line: string): ContentLine | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
  }
  return { name: parts[0].toUpperCase(), params, value };
}

/**
 * Extract the `YYYY-MM-DD` date from a DTSTART/DTEND-style line
 * (`DTSTART;VALUE=DATE:20240101`, `DTEND:20240101T120000Z`,
 * `DTSTART;TZID=Europe/Zurich:20240101T090000`).
 */
export function extractDateFromLine(line: string): string | null {
  const parsed = parseContentLine(line);
  const value = parsed ? parsed.value : line;
  return extractDateFromValue(value);
}

function extractDateFromValue(value: string): string | null {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function isDateOnlyValue(cl: ContentLine): boolean {
  return cl.params.VALUE === 'DATE' || /^\d{8}$/.test(cl.value.trim());
}

/** The browser's offset from UTC, in minutes, at `instant`. */
const browserUTCOffset: UTCOffsetFn = (instant) => -instant.getTimezoneOffset();

const UTC_DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i;

/**
 * Calendar date of a DTSTART/DTEND value, and whether it falls exactly at
 * midnight. UTC values (`20240101T230000Z`) are converted to local time first
 * (`utcOffset`, default the browser's); DATE, floating and TZID values keep
 * the date as written.
 */
export function resolveICSDateTime(
  value: string,
  utcOffset: UTCOffsetFn = browserUTCOffset
): { date: string; isMidnight: boolean } | null {
  const trimmed = value.trim();
  const utc = trimmed.match(UTC_DATE_TIME);
  if (utc) {
    const [y, mo, d, h, mi, sec] = utc.slice(1).map(Number);
    const instant = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
    // Shift by the offset and read the UTC fields: local wall-clock time
    const local = new Date(instant.getTime() + utcOffset(instant) * 60000);
    return {
      date: fromUTCDate(local),
      isMidnight:
        local.getUTCHours() === 0 && local.getUTCMinutes() === 0 && local.getUTCSeconds() === 0,
    };
  }
  const date = extractDateFromValue(trimmed);
  if (!date) return null;
  return { date, isMidnight: /^\d{8}T000000$/.test(trimmed) };
}

function toUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTCDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add `days` calendar days to a `YYYY-MM-DD` string (timezone-safe). */
export function addDaysISO(dateStr: string, days: number): string {
  const date = toUTCDate(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUTCDate(date);
}

function daysBetween(start: string, end: string): number {
  return Math.round((toUTCDate(end).getTime() - toUTCDate(start).getTime()) / 86400000);
}

/** Days in a DURATION value like `P1D`, `P2W`, `P1DT12H` (time part ignored). */
function parseDurationDays(value: string): number | null {
  const match = value.trim().match(/^[+]?P(?:(\d+)W)?(?:(\d+)D)?/);
  if (!match || (!match[1] && !match[2])) return null;
  return Number(match[1] || 0) * 7 + Number(match[2] || 0);
}

// =============================================================================
// PARSER
// =============================================================================

interface RawEvent {
  uid?: string;
  summary: string;
  description?: string;
  start?: string;
  end?: string;
  durationDays?: number;
  startIsDate: boolean;
  categories: string[];
  busyStatus?: string;
  rrule?: string;
  exdates: string[];
  recurrenceId?: string;
  cancelled: boolean;
}

interface YearlyRule {
  interval: number;
  count?: number;
  until?: string;
}

/**
 * Accept only FREQ=YEARLY rules that recur on the start date itself.
 * BYDAY / BYSETPOS etc. ("fourth Thursday of November") are not supported.
 */
function parseYearlyRule(rrule: string, start: string): YearlyRule | null {
  const parts: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) parts[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  if (parts.FREQ?.toUpperCase() !== 'YEARLY') return null;

  const [, month, day] = start.split('-').map(Number);
  for (const key of Object.keys(parts)) {
    switch (key) {
      case 'FREQ':
      case 'COUNT':
      case 'UNTIL':
      case 'INTERVAL':
      case 'WKST':
        break;
      case 'BYMONTH':
        if (Number(parts.BYMONTH) !== month) return null;
        break;
      case 'BYMONTHDAY':
        if (Number(parts.BYMONTHDAY) !== day) return null;
        break;
      default:
        return null;
    }
  }

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  const rule: YearlyRule = { interval };
  if (parts.COUNT) {
    const count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1) return null;
    rule.count = count;
  }
  if (parts.UNTIL) {
    const until = extractDateFromValue(parts.UNTIL);
    if (!until) return null;
    rule.until = until;
  }
  return rule;
}

/** Resolve start/end of a raw event to an inclusive date range. */
function resolveRange(ev: RawEvent): { start: string; end: string } | null {
  if (!ev.start) return null;
  let end = ev.start;
  if (ev.end) {
    end = ev.end;
  } else if (ev.durationDays != null && ev.durationDays > 0) {
    // DURATION is exclusive like DTEND: P1D on an all-day event is one day.
    end = addDaysISO(ev.start, ev.durationDays - (ev.startIsDate ? 1 : 0));
  }
  if (end < ev.start) end = ev.start;
  return { start: ev.start, end };
}

function toParsed(ev: RawEvent, start: string, end: string): ParsedICSEvent {
  const parsed: ParsedICSEvent = {
    summary: ev.summary,
    start_date: start,
    end_date: end,
    categories: ev.categories,
  };
  if (ev.uid) parsed.uid = ev.uid;
  if (ev.description) parsed.description = ev.description;
  if (ev.busyStatus) parsed.busyStatus = ev.busyStatus;
  return parsed;
}

function readEvents(content: string, utcOffset: UTCOffsetFn): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  // Depth of components nested inside the current VEVENT (e.g. VALARM),
  // whose properties must not overwrite the event's own.
  let nested = 0;
  // Raw DTEND line, resolved once DTSTART is known (order is not guaranteed).
  let pendingEnd: ContentLine | null = null;

  for (const line of unfoldICSLines(normalizeICSContent(content))) {
    if (!line.trim()) continue;
    const cl = parseContentLine(line);
    if (!cl) continue;

    if (cl.name === 'BEGIN') {
      if (cl.value.trim().toUpperCase() === 'VEVENT' && !current) {
        current = { summary: '', startIsDate: true, categories: [], exdates: [], cancelled: false };
        nested = 0;
        pendingEnd = null;
      } else if (current) {
        nested++;
      }
      continue;
    }
    if (cl.name === 'END') {
      if (!current) continue;
      if (nested > 0) {
        nested--;
        continue;
      }
      if (cl.value.trim().toUpperCase() === 'VEVENT') {
        if (pendingEnd && current.start) {
          const end = resolveICSDateTime(pendingEnd.value, utcOffset);
          if (end) {
            if (isDateOnlyValue(pendingEnd)) {
              // All-day DTEND is exclusive.
              current.end = addDaysISO(end.date, -1);
            } else if (end.isMidnight && end.date > current.start) {
              // A timed event ending at (local) 00:00 does not occupy that day.
              current.end = addDaysISO(end.date, -1);
            } else {
              current.end = end.date;
            }
          }
        }
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || nested > 0) continue;

    switch (cl.name) {
      case 'UID':
        current.uid = cl.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeICSText(cl.value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeICSText(cl.value).trim();
        break;
      case 'DTSTART': {
        const start = resolveICSDateTime(cl.value, utcOffset);
        if (start) {
          current.start = start.date;
          current.startIsDate = isDateOnlyValue(cl);
        }
        break;
      }
      case 'DTEND':
        pendingEnd = cl;
        break;
      case 'DURATION': {
        const days = parseDurationDays(cl.value);
        if (days != null) current.durationDays = days;
        break;
      }
      case 'CATEGORIES':
        // Comma-separated, may appear several times; escaped commas stay in a value.
        for (const cat of cl.value.split(/(?<!\\),/)) {
          const text = unescapeICSText(cat).trim();
          if (text && !current.categories.includes(text)) current.categories.push(text);
        }
        break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS':
        current.busyStatus = cl.value.trim().toUpperCase();
        break;
      case 'RRULE':
        current.rrule = cl.value.trim();
        break;
      case 'EXDATE':
        for (const v of cl.value.split(',')) {
          const date = extractDateFromValue(v);
          if (date) current.exdates.push(date);
        }
        break;
      case 'RECURRENCE-ID': {
        const date = extractDateFromValue(cl.value);
        if (date) current.recurrenceId = date;
        break;
      }
      case 'STATUS':
        current.cancelled = cl.value.trim().toUpperCase() === 'CANCELLED';
        break;
    }
  }

  return events;
}

/**
 * Parse an .ics file into all-day events.
 *
 * Yearly series are expanded from their start up to Dec 31 of (current year
 * + 2), never earlier than Jan 1 of (current year - 1). Other recurrences are
 * returned in `skipped` with reason 'unsupported recurrence'.
 */
export function parseICS(content: string, options: ParseICSOptions = {}): ParsedICS {
  const now = options.now ?? new Date();
  const currentYear = now.getFullYear();
  const windowStart = `${currentYear - 1}-01-01`;
  const windowEnd = `${currentYear + 2}-12-31`;

  const raw = readEvents(content, options.utcOffset ?? browserUTCOffset);
  const events: ParsedICSEvent[] = [];
  const skipped: SkippedICSEvent[] = [];

  // RECURRENCE-ID overrides, keyed by UID, replace one occurrence of a series.
  const overrides = new Map<string, RawEvent[]>();
  const masterUids = new Set<string>();
  for (const ev of raw) {
    if (ev.recurrenceId && ev.uid) {
      const list = overrides.get(ev.uid) ?? [];
      list.push(ev);
      overrides.set(ev.uid, list);
    } else if (ev.uid && ev.rrule) {
      masterUids.add(ev.uid);
    }
  }

  const pushSingle = (ev: RawEvent) => {
    if (ev.cancelled) {
      skipped.push({ summary: ev.summary, reason: 'cancelled' });
      return;
    }
    const range = resolveRange(ev);
    if (!range) {
      skipped.push({ summary: ev.summary, reason: 'missing date' });
      return;
    }
    events.push(toParsed(ev, range.start, range.end));
  };

  for (const ev of raw) {
    // Overrides are handled with their series; an orphan override (series not
    // in this file) is just a single event.
    if (ev.recurrenceId && ev.uid && masterUids.has(ev.uid)) continue;

    if (!ev.rrule) {
      pushSingle(ev);
      continue;
    }

    const range = resolveRange(ev);
    if (!range) {
      skipped.push({ summary: ev.summary, reason: 'missing date' });
      continue;
    }
    const rule = parseYearlyRule(ev.rrule, range.start);
    if (!rule) {
      skipped.push({ summary: ev.summary, reason: 'unsupported recurrence' });
      continue;
    }
    if (ev.cancelled) {
      skipped.push({ summary: ev.summary, reason: 'cancelled' });
      continue;
    }

    const span = daysBetween(range.start, range.end);
    const [startYear, month, day] = range.start.split('-').map(Number);
    const seriesOverrides = new Map<string, RawEvent>();
    for (const o of (ev.uid && overrides.get(ev.uid)) || []) {
      if (o.recurrenceId) seriesOverrides.set(o.recurrenceId, o);
    }
    const exdates = new Set(ev.exdates);

    let produced = 0;
    for (let year = startYear; year <= currentYear + 2; year += rule.interval) {
      if (rule.count != null && produced >= rule.count) break;
      const occDate = new Date(Date.UTC(year, month - 1, day));
      // Feb 29 in a non-leap year is not an occurrence (RFC 5545).
      if (occDate.getUTCMonth() !== month - 1) continue;
      const occStart = fromUTCDate(occDate);
      if (rule.until && occStart > rule.until) break;
      produced++;

      if (occStart < windowStart || occStart > windowEnd) continue;
      if (exdates.has(occStart)) continue;

      const override = seriesOverrides.get(occStart);
      if (override) {
        if (override.cancelled) continue;
        const oRange = resolveRange(override);
        if (oRange) {
          events.push({ ...toParsed(override, oRange.start, oRange.end), recurrence: 'yearly' });
        }
        continue;
      }
      events.push({
        ...toParsed(ev, occStart, addDaysISO(occStart, span)),
        recurrence: 'yearly',
      });
    }
  }

  // Stable sort by date for a predictable preview.
  events.sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0));

  return { events, skipped };
}

// =============================================================================
// GENERATOR
// =============================================================================

const utf8 = new TextEncoder();

/** Fold a content line at 75 octets (RFC 5545 §3.1), never splitting a character. */
function foldLine(line: string): string {
  if (utf8.encode(line).length <= 75) return line;
  const out: string[] = [];
  let chunk = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = utf8.encode(ch).length;
    if (bytes + size > limit) {
      out.push(chunk);
      chunk = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    chunk += ch;
    bytes += size;
  }
  out.push(chunk);
  return out.join('\r\n ');
}

function compactDate(dateStr: string): string {
  return dateStr.slice(0, 10).replace(/-/g, '');
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(36))
    .join('')
    .slice(0, 12);
}

/**
 * Build an .ics calendar of all-day events (DTEND exclusive), with CRLF line
 * endings, escaped text and folded long lines.
 */
export function buildICS(events: ICSExportEvent[], calendarName: string): string {
  const name = calendarName.replace(/[\r\n]+/g, ' ');
  const stamp = utcStamp(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Milestone//${name}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(name)}`,
  ];

  events.forEach((event, index) => {
    const start = event.start_date.slice(0, 10);
    const lastDay = (event.end_date || event.start_date).slice(0, 10);
    const end = addDaysISO(lastDay < start ? start : lastDay, 1);
    const uid = event.uid || `milestone-${Date.now()}-${index}-${randomId()}@milestone`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(start)}`,
      `DTEND;VALUE=DATE:${compactDate(end)}`,
      `SUMMARY:${escapeICSText(event.summary)}`,
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeICSText(event.description)}`);
    }
    lines.push('STATUS:CONFIRMED', `TRANSP:${event.transparency ?? 'OPAQUE'}`);
    if (event.busyStatus) {
      lines.push(`X-MICROSOFT-CDO-BUSYSTATUS:${event.busyStatus}`);
    }
    lines.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE', 'END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Trigger a browser download of .ics content. */
export function downloadICS(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.toLowerCase().endsWith('.ics') ? filename : `${filename}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
