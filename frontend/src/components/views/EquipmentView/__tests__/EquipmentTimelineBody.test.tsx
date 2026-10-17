/**
 * Equipment blocks (maintenance / defect windows) are edited by admins and
 * superusers only. The timeline body receives that decision as `canManage`:
 * with it, a click on a block bar opens the block editor; without it the bar
 * is tooltip-only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { EquipmentTimelineBody } from '../EquipmentTimelineBody';
import { generateTimelineCells } from '@/components/gantt/utils';
import { useUIStore } from '@/stores/uiStore';
import type { Equipment, EquipmentBlock } from '@/types';

const equipment: Equipment = { id: 3, name: 'HPLC', type: 'Analytical', site_id: 1, active: true };

const block: EquipmentBlock = {
  id: 11,
  equipment_id: 3,
  start_date: '2026-09-10',
  end_date: '2026-09-12',
  reason: 'maintenance',
  description: 'Pump service',
};

function renderBody(canManage: boolean, expanded = false) {
  const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
  return render(
    <EquipmentTimelineBody
      equipment={[equipment]}
      bookingsMap={new Map()}
      blocksMap={new Map([[3, [block]]])}
      overlapMap={new Map()}
      expandedEquipment={expanded ? new Set([3]) : new Set()}
      canManage={canManage}
      cells={cells}
      cellWidth={30}
      totalWidth={cells.length * 30}
      viewMode="month"
    />
  );
}

const blockBars = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[title="Pump service (maintenance)"]'));

beforeEach(() => {
  useUIStore.setState({ activeModal: null, editingEquipmentBlock: null });
});

describe('EquipmentTimelineBody block bars', () => {
  it('open the block editor for someone who manages blocks', () => {
    const { container } = renderBody(true);
    const [bar] = blockBars(container);

    fireEvent.click(bar);

    expect(useUIStore.getState().activeModal).toBe('equipmentBlock');
    expect(useUIStore.getState().editingEquipmentBlock?.id).toBe(11);
  });

  it('are tooltip-only otherwise, on the main row and the expanded detail row', () => {
    const { container } = renderBody(false, true);
    const bars = blockBars(container);
    expect(bars).toHaveLength(2);

    bars.forEach((bar) => fireEvent.click(bar));

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().editingEquipmentBlock).toBeNull();
  });
});
