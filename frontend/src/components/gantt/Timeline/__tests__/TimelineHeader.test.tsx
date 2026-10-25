/**
 * The header's day cells take the colour of their first company event
 * (`--event-color` on the background and the label) and name every event of
 * the cell in the label's title, the bank holiday first. The label's text
 * mixes that colour with the text colour, so a pale event stays legible.
 * Below the labels, the events row holds the strip (TimelineMarkers) at
 * every zoom, for the current site.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TimelineHeader } from '../TimelineHeader';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
import { useAppStore } from '@/stores/appStore';
import { makeSite, makeTeam, makeUser } from '@/test/factories';
import type { ViewMode } from '@/types';

const HOLIDAY = '2026-04-06';
const cells = (mode: ViewMode = 'month') =>
  generateTimelineCells(
    new Date(2026, 3, 6),
    mode,
    new Set([HOLIDAY]),
    [{ date: HOLIDAY, name: 'Easter Monday' }],
    new Set([HOLIDAY, '2026-04-08', '2026-04-09', '2026-04-10']),
    [
      { id: 1, date: HOLIDAY, name: 'ISO 9001 audit', color: '#f59e0b' },
      { id: 2, date: HOLIDAY, name: 'Lab safety walk-through', color: '#14b8a6' },
      { id: 3, date: '2026-04-08', name: 'Instrument calibration day', color: '#a855f7', team_ids: [10] },
      { id: 4, date: '2026-04-09', name: 'Supplier visit' },
      { id: 5, date: '2026-04-10', name: 'Review', color: '#14b8a6' },
      { id: 6, date: '2026-04-10', name: 'Workshop' },
    ]
  );

function renderHeader(mode: ViewMode = 'month') {
  const list = cells(mode);
  const utils = render(
    <TimelineHeader
      headers={generateTimelineHeaders(list, mode)}
      cells={list}
      cellWidth={20}
      totalWidth={list.length * 20}
      viewMode={mode}
    />
  );
  const label = (dateStr: string) => utils.container.querySelector<HTMLElement>(`[data-date="${dateStr}"]`)!;
  const background = (dateStr: string) => {
    const index = list.findIndex((c) => c.dateStr === dateStr);
    return [...utils.container.querySelectorAll<HTMLElement>('[class*="bgCell"]')].find(
      (el) => el.style.left === `${index * 20}px`
    );
  };
  return { ...utils, label, background };
}

describe('TimelineHeader company events', () => {
  it('sets the first event colour on both the background and the label cell', () => {
    const { label, background } = renderHeader();
    const bg = background('2026-04-08')!;
    expect(bg.className).toContain('eventBg');
    expect(bg.style.getPropertyValue('--event-color')).toBe('#a855f7');
    expect(label('2026-04-08').className).toContain('eventText');
    expect(label('2026-04-08').style.getPropertyValue('--event-color')).toBe('#a855f7');
  });

  it('mixes the label colour with the text colour so pale events stay legible', () => {
    // jsdom applies no CSS module, so the rule is read from the stylesheet
    const css = readFileSync(join(__dirname, '..', 'TimelineHeader.module.css'), 'utf8');
    const rule = css.match(/\.secondaryCell\.eventText\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain(
      'color: color-mix(in srgb, var(--event-color, var(--accent-red)) 70%, var(--text-primary));'
    );
  });

  it('sets no colour variable for an event without a colour', () => {
    const { label, background } = renderHeader();
    expect(background('2026-04-09')!.className).toContain('eventBg');
    expect(background('2026-04-09')!.style.getPropertyValue('--event-color')).toBe('');
    expect(label('2026-04-09').className).toContain('eventText');
    expect(label('2026-04-09').style.getPropertyValue('--event-color')).toBe('');
  });

  it('names the holiday first, then every event, with the count when several', () => {
    const { label } = renderHeader();
    expect(label(HOLIDAY).title).toBe('Easter Monday · ISO 9001 audit · Lab safety walk-through (2 events)');
    // The holiday still wins the cell's class
    expect(label(HOLIDAY).className).toContain('holidayText');
  });

  it('joins several events without a holiday, and names a single event alone', () => {
    const { label } = renderHeader();
    expect(label('2026-04-10').title).toBe('Review · Workshop (2 events)');
    expect(label('2026-04-08').title).toBe('Instrument calibration day');
  });

  it('has no title on a day without holiday or event', () => {
    const { label } = renderHeader();
    expect(label('2026-04-07').hasAttribute('title')).toBe(false);
    expect(label('2026-04-07').style.getPropertyValue('--event-color')).toBe('');
  });

  it('names a holiday alone', () => {
    const list = generateTimelineCells(new Date(2026, 3, 6), 'month', new Set([HOLIDAY]), [{ date: HOLIDAY, name: 'Easter Monday' }]);
    const { container } = render(
      <TimelineHeader headers={generateTimelineHeaders(list, 'month')} cells={list} cellWidth={20} totalWidth={list.length * 20} viewMode="month" />
    );
    expect(container.querySelector<HTMLElement>(`[data-date="${HOLIDAY}"]`)!.title).toBe('Easter Monday');
  });

  it('names every event of a quarter week on its label, without the background layer', () => {
    const { label, container } = renderHeader('quarter');
    // Week of Monday 6 April: the Monday is the holiday (first-day rule)
    expect(label(HOLIDAY).title).toBe(
      'Easter Monday · ISO 9001 audit · Lab safety walk-through · Instrument calibration day · Supplier visit · Review · Workshop (6 events)'
    );
    expect(label(HOLIDAY).style.getPropertyValue('--event-color')).toBe('#f59e0b');
    expect(container.querySelector('[class*="bgLayer"]')).toBeNull();
  });
});

describe('TimelineHeader events row', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentSite: makeSite({ id: 1 }),
      currentUser: makeUser({ role: 'user' }),
      teams: [makeTeam({ id: 10, site_id: 1, name: 'Analytical Lab' })],
    });
  });

  it.each(['week', 'month', 'quarter', 'year'] as ViewMode[])(
    'draws the strip once, in its own row below the day labels, at %s zoom',
    (mode) => {
      const { container } = renderHeader(mode);
      const rows = container.querySelectorAll('[class*="eventsRow"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].previousElementSibling?.className).toContain('secondaryRow');
      const layers = container.querySelectorAll('[class*="markerLayer"]');
      expect(layers).toHaveLength(1);
      expect(rows[0].contains(layers[0])).toBe(true);
      expect(layers[0].querySelectorAll('button[aria-haspopup="dialog"]').length).toBeGreaterThan(0);
    }
  );

  it('keeps the custom-column spacer below the events row', () => {
    const list = cells('month');
    const { container } = render(
      <TimelineHeader
        headers={generateTimelineHeaders(list, 'month')}
        cells={list}
        cellWidth={20}
        totalWidth={list.length * 20}
        viewMode="month"
        hasCustomColumns
      />
    );
    const spacer = container.querySelector('[class*="customColumnSpacer"]')!;
    expect(spacer.previousElementSibling?.className).toContain('eventsRow');
  });

  it('names the teams of the current site in the panel', () => {
    const { container } = renderHeader('month');
    const index = cells('month').findIndex((c) => c.dateStr === '2026-04-08');
    fireEvent.click(container.querySelector(`[class*="markerBadge"][data-cell-index="${index}"]`)!);
    expect(within(screen.getByRole('dialog')).getByText('Teams: Analytical Lab')).toBeInTheDocument();
  });

  it('sizes its rows to --timeline-header-total (23 + 28 + 14 + the 1 px border)', () => {
    const css = readFileSync(join(__dirname, '..', 'TimelineHeader.module.css'), 'utf8');
    const px = (selector: string, prop: string) => {
      const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      return Number(rule.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`))?.[1]);
    };
    expect(px('primaryRow', 'height')).toBe(23);
    expect(px('secondaryRow', 'height')).toBe(28);
    expect(px('eventsRow', 'height')).toBe(14);
    expect(css).toMatch(/\.header\s*\{[^}]*border-bottom: 1px solid/);
    expect(23 + 28 + 14 + 1).toBe(66);
  });
});
