/**
 * Project expansion levels, shared by the viewStore's level-based
 * expand/collapse actions and the project row's +/- buttons, so the buttons
 * enable and disable on exactly the levels the store steps through.
 */

import type { Project, Subphase } from '@/types';

export interface LevelItem {
  type: 'phase' | 'subphase';
  id: number;
  hasChildren: boolean;
}

export interface LevelMap {
  [level: number]: LevelItem[];
}

/**
 * Get all expandable items at each level for a project: level 1 = phases
 * (milestones excluded), 2 = their direct subphases, 3 = nested subphases,
 * and so on for deeper nesting.
 */
export function getProjectLevelItems(project: Project): { levels: LevelMap; maxLevel: number } {
  const levels: LevelMap = {
    1: [], // Phases
  };

  // Collect phases and their children
  for (const phase of (project.phases || [])) {
    if (!phase.is_milestone) {
      const children = phase.children || [];
      const hasChildren = children.length > 0;
      levels[1].push({ type: 'phase', id: phase.id, hasChildren });

      // Collect children recursively
      if (hasChildren) {
        collectSubphaseLevels(children, 2, levels);
      }
    }
  }

  // Find max level with content
  let maxLevel = 0;
  for (const lvl in levels) {
    if (levels[lvl] && levels[lvl].length > 0) {
      maxLevel = Math.max(maxLevel, parseInt(lvl));
    }
  }

  // Always allow expanding to at least level 1
  maxLevel = Math.max(maxLevel, 1);

  return { levels, maxLevel };
}

function collectSubphaseLevels(subphases: Subphase[], level: number, levels: LevelMap): void {
  if (!subphases || subphases.length === 0) return;
  if (!levels[level]) levels[level] = [];

  for (const sub of subphases) {
    const children = sub.children || [];
    const hasChildren = children.length > 0;
    levels[level].push({ type: 'subphase', id: sub.id, hasChildren });

    if (hasChildren) {
      collectSubphaseLevels(children, level + 1, levels);
    }
  }
}

/**
 * Get the current expansion level for a project (0 = collapsed, 1 = phases
 * shown, n = level n reached). Equals `maxLevel` once fully expanded.
 */
export function getCurrentExpansionLevel(
  project: Project,
  expandedProjects: Set<number>,
  expandedPhases: Set<number>,
  expandedSubphases: Set<number>
): number {
  if (!expandedProjects.has(project.id)) return 0;

  const { levels, maxLevel } = getProjectLevelItems(project);

  // If no phases, we're at level 1
  if (!levels[1] || levels[1].length === 0) return 1;

  // Check if ANY phase is expanded
  const anyPhaseExpanded = levels[1].some(item => expandedPhases.has(item.id));
  if (!anyPhaseExpanded) return 1;

  // At least one phase is expanded, so we're at level 2 minimum
  // Now check subphase levels
  for (let lvl = 2; lvl <= maxLevel; lvl++) {
    if (!levels[lvl] || levels[lvl].length === 0) continue;

    // Check if ANY subphase at this level is expanded
    const anyExpanded = levels[lvl].some(item => expandedSubphases.has(item.id));
    if (!anyExpanded) return lvl;
  }

  return maxLevel;
}
