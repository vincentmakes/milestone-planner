/**
 * Row position calculator
 * Calculates the position of each phase/subphase row based on expanded state
 */

import type { Project, Subphase } from '@/types';

// Row heights - CSS variables
// --row-height: 44px (project rows)
// --detail-row-height: 32px (phase, subphase, assignment rows)
// All rows have border-bottom: 1px with box-sizing: content-box
// So total occupied space = height + 1px border

// Visual height (for calculating center) - detail rows only since we only track phase/subphase positions
const DETAIL_ROW_VISIBLE_HEIGHT = 32;

// Total height including border (for position advancement)
const PROJECT_ROW_TOTAL_HEIGHT = 45;  // 44 + 1
const DETAIL_ROW_TOTAL_HEIGHT = 33;   // 32 + 1

export interface RowPosition {
  top: number;
  height: number;
}

export interface RowPositionsResult {
  positions: Map<string, RowPosition>;
  totalHeight: number;
  phantomRowTop?: number; // Position of phantom row if active
}

export interface PhantomRowConfig {
  projectId: number;
  sourceId: number;
  type: 'phase' | 'subphase';
  parentId?: number | null;
  parentType?: 'phase' | 'subphase';
}

/**
 * Calculate row positions for all visible phases and subphases
 * Optionally includes a phantom row for phantom sibling mode
 */
export function calculateRowPositions(
  projects: Project[],
  expandedProjects: Set<number>,
  expandedPhases: Set<number>,
  expandedSubphases: Set<number>,
  phantomConfig?: PhantomRowConfig | null
): RowPositionsResult {
  const positions = new Map<string, RowPosition>();
  let currentTop = 0;
  let phantomRowTop: number | undefined;

  projects.forEach((project) => {
    // Project row - advance past it
    currentTop += PROJECT_ROW_TOTAL_HEIGHT;

    // If project is expanded, add phases
    if (expandedProjects.has(project.id)) {
      (project.phases ?? []).forEach((phase) => {
        // Phase row - record position with visible height for center calculation
        const phaseTop = currentTop;
        positions.set(`phase-${phase.id}`, { top: phaseTop, height: DETAIL_ROW_VISIBLE_HEIGHT });
        currentTop += DETAIL_ROW_TOTAL_HEIGHT;

        // Check if phantom row should be inserted after this phase
        if (phantomConfig?.type === 'phase' && 
            phantomConfig.projectId === project.id && 
            phantomConfig.sourceId === phase.id) {
          phantomRowTop = currentTop;
          positions.set('phantom', { top: currentTop, height: DETAIL_ROW_VISIBLE_HEIGHT });
          currentTop += DETAIL_ROW_TOTAL_HEIGHT;
        }

        // If phase is expanded, add subphases and assignments
        if (expandedPhases.has(phase.id)) {
          // Add subphases recursively (with phantom support)
          const subphaseResult = addSubphasePositions(
            phase.children ?? [],
            positions,
            currentTop,
            expandedSubphases,
            phantomConfig,
            project.id,
            phase.id
          );
          currentTop = subphaseResult.currentTop;
          if (subphaseResult.phantomRowTop !== undefined) {
            phantomRowTop = subphaseResult.phantomRowTop;
          }

          // Add phase staff assignments
          const phaseStaffCount = phase.staffAssignments?.length ?? 0;
          currentTop += phaseStaffCount * DETAIL_ROW_TOTAL_HEIGHT;

          // Add phase equipment assignments
          const phaseEquipCount = phase.equipmentAssignments?.length ?? 0;
          currentTop += phaseEquipCount * DETAIL_ROW_TOTAL_HEIGHT;
        }
      });

      // Add project-level staff assignments
      const projectStaffCount = project.staffAssignments?.length ?? 0;
      currentTop += projectStaffCount * DETAIL_ROW_TOTAL_HEIGHT;

      // Add project-level equipment assignments
      const projectEquipCount = project.equipmentAssignments?.length ?? 0;
      currentTop += projectEquipCount * DETAIL_ROW_TOTAL_HEIGHT;
    }
  });

  return { positions, totalHeight: currentTop, phantomRowTop };
}

/**
 * Recursively add subphase positions with phantom row support
 */
function addSubphasePositions(
  subphases: Subphase[],
  positions: Map<string, RowPosition>,
  currentTop: number,
  expandedSubphases: Set<number>,
  phantomConfig?: PhantomRowConfig | null,
  projectId?: number,
  _parentPhaseId?: number,
  _parentSubphaseId?: number
): { currentTop: number; phantomRowTop?: number } {
  let phantomRowTop: number | undefined;

  subphases.forEach((subphase) => {
    positions.set(`subphase-${subphase.id}`, { top: currentTop, height: DETAIL_ROW_VISIBLE_HEIGHT });
    currentTop += DETAIL_ROW_TOTAL_HEIGHT;

    // Check if phantom row should be inserted after this subphase
    if (phantomConfig?.type === 'subphase' && 
        phantomConfig.projectId === projectId && 
        phantomConfig.sourceId === subphase.id) {
      phantomRowTop = currentTop;
      positions.set('phantom', { top: currentTop, height: DETAIL_ROW_VISIBLE_HEIGHT });
      currentTop += DETAIL_ROW_TOTAL_HEIGHT;
    }

    // If subphase is expanded, add children and assignments
    if (expandedSubphases.has(subphase.id)) {
      // Add nested subphases
      if (subphase.children?.length) {
        const nestedResult = addSubphasePositions(
          subphase.children,
          positions,
          currentTop,
          expandedSubphases,
          phantomConfig,
          projectId,
          _parentPhaseId,
          subphase.id
        );
        currentTop = nestedResult.currentTop;
        if (nestedResult.phantomRowTop !== undefined) {
          phantomRowTop = nestedResult.phantomRowTop;
        }
      }

      // Add subphase staff assignments
      const staffCount = subphase.staffAssignments?.length ?? 0;
      currentTop += staffCount * DETAIL_ROW_TOTAL_HEIGHT;

      // Add subphase equipment assignments  
      const equipCount = subphase.equipmentAssignments?.length ?? 0;
      currentTop += equipCount * DETAIL_ROW_TOTAL_HEIGHT;
    }
  });

  return { currentTop, phantomRowTop };
}
