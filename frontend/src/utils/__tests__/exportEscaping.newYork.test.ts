/**
 * Client-side project exports: CSV formula injection (F1-9), XML escaping, and
 * calendar dates that must not shift a day west of UTC (F1-6). Pinned to
 * America/New_York so the date regression shows up on any machine.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, afterAll } from 'vitest';
import { exportProjectsToCSV, csvTextCell } from '../csvExport';
import { createMSProjectXML, escapeXml } from '../xmlExport';
import type { Project } from '@/types';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function project(phaseName: string, customer: string | null = null): Project {
  return {
    id: 1,
    name: 'Bioprocess',
    site_id: 1,
    customer,
    confirmed: true,
    archived: false,
    start_date: '2026-03-02T00:00:00.000Z',
    end_date: '2026-03-06T00:00:00.000Z',
    phases: [
      {
        id: 10,
        project_id: 1,
        name: phaseName,
        start_date: '2026-03-02T00:00:00.000Z',
        end_date: '2026-03-06T00:00:00.000Z',
        color: '#000',
        order_index: 0,
        status: 'todo',
        dependencies: [],
        children: [],
        staffAssignments: [],
        equipmentAssignments: [],
      },
    ],
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

describe('csvTextCell', () => {
  it.each([
    ['=HYPERLINK("https://evil.example","x")', `"'=HYPERLINK(""https://evil.example"",""x"")"`],
    ['+1+1', `"'+1+1"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\t=1', `"'\t=1"`],
    ['\r=1', `"'\r=1"`],
  ])('neutralises formula trigger %j', (input, expected) => {
    expect(csvTextCell(input)).toBe(expected);
  });

  it('leaves ordinary text alone apart from quote doubling', () => {
    expect(csvTextCell('Scale-up "phase" 2')).toBe('"Scale-up ""phase"" 2"');
    expect(csvTextCell('')).toBe('""');
    expect(csvTextCell(null)).toBe('""');
  });
});

describe('exportProjectsToCSV', () => {
  it('prefixes a formula-looking phase name in the exported file', () => {
    const csv = exportProjectsToCSV([project('=cmd|\' /C calc\'!A0')]);
    expect(csv).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(csv).not.toMatch(/,"=cmd/);
  });

  it('exports the stored calendar dates, not the previous day', () => {
    const csv = exportProjectsToCSV([project('Phase A')]);
    const phaseLine = csv.split('\n').find((l) => l.includes('Phase A'))!;
    expect(phaseLine).toContain('03/02/2026');
    expect(phaseLine).toContain('03/06/2026');
    expect(phaseLine).toContain('5d');
    expect(csv).not.toContain('03/01/2026');
  });
});

describe('createMSProjectXML', () => {
  it('escapes markup and strips characters XML 1.0 forbids', () => {
    expect(escapeXml(`<a & "b" 'c'>\u0001\u0008ok`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;ok');
    const xml = createMSProjectXML(project('</Name><Evil>', 'ACME\u0000'));
    expect(xml).toContain('<Name>&lt;/Name&gt;&lt;Evil&gt;</Name>');
    expect(xml).toContain('<Company>ACME</Company>');
  });

  it('writes valid dates for the backend midnight-UTC date form', () => {
    const xml = createMSProjectXML(project('Phase A'));
    expect(xml).toContain('<StartDate>2026-03-02T08:00:00</StartDate>');
    expect(xml).toContain('<FinishDate>2026-03-06T17:00:00</FinishDate>');
    expect(xml).toContain('<Start>2026-03-02T08:00:00</Start>');
    expect(xml).not.toContain('ZT08');
  });
});
