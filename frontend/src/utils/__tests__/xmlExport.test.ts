import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMSProjectXML, downloadXML, exportProjectToXML } from '../xmlExport';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';

function project() {
  const nested = makeSubphase({
    id: 3,
    name: 'Sign-off',
    start_date: '2026-02-10',
    end_date: '2026-02-10',
  });
  const sub = makeSubphase({
    id: 2,
    name: 'Lab work',
    start_date: '2026-01-05T00:00:00.000Z',
    end_date: '2026-02-10',
    completion: 50,
    children: [nested],
  });
  return makeProject({
    name: 'Scale <Up> & Go',
    customer: 'Acme',
    phases: [makePhase({ name: 'Feasibility', completion: 25, children: [sub] })],
  });
}

describe('createMSProjectXML', () => {
  it('writes the project header with escaped name and company', () => {
    const xml = createMSProjectXML(project());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(xml).toContain('<Name>Scale &lt;Up&gt; &amp; Go</Name>');
    expect(xml).toContain('<Company>Acme</Company>');
    expect(xml).toContain('<StartDate>2026-01-05T08:00:00</StartDate>');
    expect(xml).toContain('<FinishDate>2026-06-30T17:00:00</FinishDate>');
  });

  it('emits one task per level with outline levels, milestones and completion', () => {
    const xml = createMSProjectXML(project());
    const tasks = xml.split('<Task>').slice(1);
    expect(tasks).toHaveLength(4);
    const field = (task: string, name: string) => task.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
    expect(tasks.map((t) => field(t, 'OutlineLevel'))).toEqual(['0', '1', '2', '3']);
    expect(tasks.map((t) => field(t, 'UID'))).toEqual(['1', '2', '3', '4']);
    expect(tasks.map((t) => field(t, 'PercentComplete'))).toEqual(['0', '25', '50', '0']);
    expect(tasks.map((t) => field(t, 'Milestone'))).toEqual(['0', '0', '0', '1']);
    // Backend midnight-UTC dates are reduced to the calendar date.
    expect(field(tasks[2], 'Start')).toBe('2026-01-05T08:00:00');
  });

  it('omits dates that are missing and writes an empty company', () => {
    const xml = createMSProjectXML(
      makeProject({ customer: null, start_date: '', end_date: '', phases: [] })
    );
    expect(xml).toContain('<Company></Company>');
    expect(xml).not.toContain('<StartDate>');
    expect(xml).not.toContain('<FinishDate>');
    expect(xml).not.toContain('<Start>');
    expect(xml.split('<Task>')).toHaveLength(2);
  });
});

describe('downloadXML / exportProjectToXML', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads a blob through a temporary link and revokes the URL', () => {
    const createObjectURL = vi.fn(() => 'blob:xml');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    exportProjectToXML(makeProject({ name: 'My  Project 1' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/xml;charset=utf-8;');
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('My_Project_1.xml');
    expect(link.href).toBe('blob:xml');
    expect(document.body.contains(link)).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:xml');
  });

  it('downloadXML uses the given file name', () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadXML('<x/>', 'a.xml');
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('a.xml');
  });
});
