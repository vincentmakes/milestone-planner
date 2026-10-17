/**
 * CSV / XML cell escaping edge cases not covered by exportEscaping.newYork
 * (which pins a timezone for the date cases).
 */
import { describe, it, expect } from 'vitest';
import { csvTextCell } from '../csvExport';
import { escapeXml } from '../xmlExport';

describe('csvTextCell', () => {
  it('keeps embedded newlines and commas inside one quoted cell', () => {
    expect(csvTextCell('line 1\nline 2, more')).toBe('"line 1\nline 2, more"');
  });

  it('does not prefix a trigger character that is not the first character', () => {
    expect(csvTextCell('Phase = 1')).toBe('"Phase = 1"');
    expect(csvTextCell('A-B test')).toBe('"A-B test"');
  });

  it('prefixes and quote-doubles together', () => {
    expect(csvTextCell('="x"')).toBe(`"'=""x"""`);
  });
});

describe('escapeXml', () => {
  it('escapes ampersands first (no double escaping of entities)', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('keeps legal whitespace and astral characters, drops lone surrogates', () => {
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    expect(escapeXml('rocket \u{1F680}')).toBe('rocket \u{1F680}');
    expect(escapeXml('bad \uD800 end')).toBe('bad  end');
  });
});
