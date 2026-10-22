/**
 * SegmentsBar: one person's bookings on a card as read-only blocks on one
 * timeline row -- each at its effective dates (own dates when unlinked, the
 * card's when linked), tinted with the card's colour, hatched while a request
 * is open, with a "name · start – end · allocation%" tooltip. No block is a
 * drag target.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SegmentsBar } from '../SegmentsBar';
import { calculateBarPosition, generateTimelineCells } from '../../utils';
import { formatMediumDate } from '@/utils/date';
import type { StaffAssignment } from '@/types';

const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
const card = { start_date: '2026-09-01', end_date: '2026-09-20', color: '#3b82f6' };

const rows = [
  { id: 1, staff_id: 4, allocation: 20, start_date: '2026-09-02', end_date: '2026-09-04', linked: false },
  {
    id: 2,
    staff_id: 4,
    allocation: 60,
    start_date: '2026-09-10',
    end_date: '2026-09-12',
    linked: false,
    approval_status: 'pending',
  },
  { id: 3, staff_id: 4, allocation: 40, start_date: '', end_date: '' }, // linked: spans the card
] as StaffAssignment[];

function renderBar(props: Partial<React.ComponentProps<typeof SegmentsBar>> = {}) {
  return render(
    <SegmentsBar rows={rows} card={card} name="Bob Brown" cells={cells} cellWidth={30} viewMode="month" {...props} />
  );
}

const blocks = (container: HTMLElement) => [...container.children] as HTMLElement[];

describe('SegmentsBar', () => {
  it('draws one block per booking at its effective dates', () => {
    const { container } = renderBar();
    const expected = [
      calculateBarPosition('2026-09-02', '2026-09-04', cells, 30, 'month'),
      calculateBarPosition('2026-09-10', '2026-09-12', cells, 30, 'month'),
      calculateBarPosition('2026-09-01', '2026-09-20', cells, 30, 'month'),
    ];
    expect(blocks(container).map((b) => ({ left: b.style.left, width: b.style.width }))).toEqual(
      expected.map((p) => ({ left: `${p!.left}px`, width: `${p!.width}px` }))
    );
    for (const b of blocks(container)) {
      expect(b.style.getPropertyValue('--segment-color')).toBe('#3b82f6');
      expect(b.className).not.toMatch(/row/);
      expect([...b.attributes].some((a) => a.name.startsWith('data-'))).toBe(false);
    }
  });

  it('hatches a booking awaiting approval or with an open request', () => {
    const withRequest = [
      rows[0],
      rows[1],
      { ...rows[2], approval: { request_id: 9, action: 'assignments.self_update' } },
    ] as StaffAssignment[];
    const { container } = renderBar({ rows: withRequest });
    expect(blocks(container).map((b) => /pendingSegment/.test(b.className))).toEqual([false, true, true]);
  });

  it('names the person, dates and allocation in the tooltip', () => {
    const { container } = renderBar();
    expect(blocks(container)[0]).toHaveAttribute(
      'title',
      `Bob Brown · ${formatMediumDate('2026-09-02')} – ${formatMediumDate('2026-09-04')} · 20%`
    );
    expect(blocks(container)[2]).toHaveAttribute(
      'title',
      `Bob Brown · ${formatMediumDate('2026-09-01')} – ${formatMediumDate('2026-09-20')} · 40%`
    );
  });

  it('skips a block outside the timeline and keeps the default colour without a card colour', () => {
    const { container } = renderBar({
      rows: [rows[0], { ...rows[1], start_date: '2040-06-01', end_date: '2040-06-02' }],
      card: { start_date: '2026-09-01', end_date: '2040-06-30' },
    });
    expect(blocks(container)).toHaveLength(1);
    expect(blocks(container)[0].style.getPropertyValue('--segment-color')).toBe('');
  });
});
