/**
 * Memoized lookup of equipment booking/block overlaps.
 *
 * Returns a Map keyed by equipment id with `{ hasOverlap, segments }` for
 * every equipment that has any reservation. Equipment without reservations
 * are absent from the map (callers should default to "no overlap").
 *
 * Recomputes only when `projects` or `equipmentBlocks` change identity in the
 * appStore.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { buildEquipmentOverlapMap } from '@/utils/equipmentOverlap';
import type { OverlapInfo } from '@/utils/equipmentOverlap';

export function useEquipmentOverlaps(): Map<number, OverlapInfo> {
  const projects = useAppStore((s) => s.projects);
  const equipmentBlocks = useAppStore((s) => s.equipmentBlocks);

  return useMemo(
    () => buildEquipmentOverlapMap(projects, equipmentBlocks),
    [projects, equipmentBlocks],
  );
}
