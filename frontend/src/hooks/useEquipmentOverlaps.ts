/**
 * Memoized lookup of equipment booking/block overlaps and "what is each
 * equipment doing today" state.
 *
 * Returns:
 *  - `overlapMap` — Map<equipmentId, { hasOverlap, segments }>; equipment
 *    without overlaps are absent (default "no overlap").
 *  - `todayStatusMap` — Map<equipmentId, 'blocked' | 'booked'>; equipment
 *    that are free today are absent (default "available"). "blocked" wins
 *    over "booked" when both apply.
 *
 * Recomputes only when `projects` or `equipmentBlocks` change identity in
 * the appStore.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  buildEquipmentOverlapMap,
  buildEquipmentTodayStatusMap,
} from '@/utils/equipmentOverlap';
import type { OverlapInfo, EquipmentTodayStatus } from '@/utils/equipmentOverlap';

export function useEquipmentOverlaps(): Map<number, OverlapInfo> {
  const projects = useAppStore((s) => s.projects);
  const equipmentBlocks = useAppStore((s) => s.equipmentBlocks);

  return useMemo(
    () => buildEquipmentOverlapMap(projects, equipmentBlocks),
    [projects, equipmentBlocks],
  );
}

export function useEquipmentTodayStatus(): Map<number, EquipmentTodayStatus> {
  const projects = useAppStore((s) => s.projects);
  const equipmentBlocks = useAppStore((s) => s.equipmentBlocks);

  return useMemo(
    () => buildEquipmentTodayStatusMap(projects, equipmentBlocks),
    [projects, equipmentBlocks],
  );
}
