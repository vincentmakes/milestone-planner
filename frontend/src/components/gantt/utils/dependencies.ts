/**
 * Dependency utilities
 * Functions for extracting dependencies and calculating arrow paths
 */

import type { Project, Phase, Subphase, DependencyLink, DependencyType } from '@/types';
import { getPhaseColor } from '@/utils/themeColors';

/**
 * Extract all dependency links from projects
 * Dependencies are stored on each phase/subphase as an array of {id, type} 
 * where id is the predecessor's ID
 */
export function extractDependencies(projects: Project[]): DependencyLink[] {
  const links: DependencyLink[] = [];

  projects.forEach((project) => {
    // Extract from phases
    (project.phases ?? []).forEach((phase) => {
      (phase.dependencies ?? []).forEach((dep) => {
        // Determine if predecessor is phase or subphase
        const { item: predItem, type: predType } = findPhaseOrSubphase(project, dep.id);
        if (predItem) {
          links.push({
            id: `dep-${predType}-${dep.id}-phase-${phase.id}`,
            fromId: dep.id,
            fromType: predType,
            toId: phase.id,
            toType: 'phase',
            type: dep.type || 'FS',
            lag: dep.lag ?? 0,
            projectId: project.id,
          });
        }
      });

      // Extract from subphases recursively
      extractSubphaseDependencies(project, phase.children ?? [], links);
    });
  });

  return links;
}

/**
 * Recursively extract dependencies from subphases
 */
function extractSubphaseDependencies(
  project: Project,
  subphases: Subphase[],
  links: DependencyLink[]
): void {
  subphases.forEach((subphase) => {
    (subphase.dependencies ?? []).forEach((dep) => {
      const { item: predItem, type: predType } = findPhaseOrSubphase(project, dep.id);
      if (predItem) {
        links.push({
          id: `dep-${predType}-${dep.id}-subphase-${subphase.id}`,
          fromId: dep.id,
          fromType: predType,
          toId: subphase.id,
          toType: 'subphase',
          type: dep.type || 'FS',
          lag: dep.lag ?? 0,
          projectId: project.id,
        });
      }
    });

    // Recurse into children
    if (subphase.children?.length) {
      extractSubphaseDependencies(project, subphase.children, links);
    }
  });
}

/**
 * Find a phase or subphase by ID within a project
 */
function findPhaseOrSubphase(
  project: Project,
  id: number
): { item: Phase | Subphase | null; type: 'phase' | 'subphase' } {
  // Check phases first
  const phase = (project.phases ?? []).find((p) => p.id === id);
  if (phase) {
    return { item: phase, type: 'phase' };
  }

  // Check subphases recursively
  for (const p of project.phases ?? []) {
    const subphase = findSubphaseById(p.children ?? [], id);
    if (subphase) {
      return { item: subphase, type: 'subphase' };
    }
  }

  return { item: null, type: 'subphase' };
}

/**
 * Recursively find a subphase by ID
 */
function findSubphaseById(subphases: Subphase[], id: number): Subphase | null {
  for (const sp of subphases) {
    if (sp.id === id) return sp;
    if (sp.children?.length) {
      const found = findSubphaseById(sp.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Get the dates for a phase or subphase
 */
export function getItemDates(
  project: Project,
  id: number,
  _type: 'phase' | 'subphase'
): { start_date: string; end_date: string } | null {
  const { item } = findPhaseOrSubphase(project, id);
  if (item) {
    return { start_date: item.start_date, end_date: item.end_date };
  }
  return null;
}

/**
 * Dependency line styles based on type
 */
export const DEPENDENCY_STYLES: Record<DependencyType, { dashArray: string; description: string }> = {
  FS: { dashArray: '', description: 'Finish-to-Start (solid)' },           // Solid line
  SS: { dashArray: '6,3', description: 'Start-to-Start (long dash)' },     // Long dash
  FF: { dashArray: '4,2', description: 'Finish-to-Finish (short dash)' },  // Short dash
  SF: { dashArray: '2,2', description: 'Start-to-Finish (dotted)' },       // Very short dash
};

// Corner radius for rounded paths
const CORNER_RADIUS = 5;

/**
 * Create a rounded corner path segment
 * Takes a corner point and the direction of incoming/outgoing lines
 */
function roundedCorner(
  cornerX: number,
  cornerY: number,
  fromDir: 'left' | 'right' | 'up' | 'down',
  toDir: 'left' | 'right' | 'up' | 'down',
  radius: number = CORNER_RADIUS
): string {
  // Calculate control points based on directions
  const r = radius;
  
  // Determine the arc sweep direction
  // fromDir -> toDir determines if we go clockwise or counter-clockwise
  const turns: Record<string, { dx1: number; dy1: number; dx2: number; dy2: number; sweep: number }> = {
    'right-down': { dx1: -r, dy1: 0, dx2: 0, dy2: r, sweep: 1 },
    'right-up':   { dx1: -r, dy1: 0, dx2: 0, dy2: -r, sweep: 0 },
    'left-down':  { dx1: r, dy1: 0, dx2: 0, dy2: r, sweep: 0 },
    'left-up':    { dx1: r, dy1: 0, dx2: 0, dy2: -r, sweep: 1 },
    'down-right': { dx1: 0, dy1: -r, dx2: r, dy2: 0, sweep: 0 },
    'down-left':  { dx1: 0, dy1: -r, dx2: -r, dy2: 0, sweep: 1 },
    'up-right':   { dx1: 0, dy1: r, dx2: r, dy2: 0, sweep: 1 },
    'up-left':    { dx1: 0, dy1: r, dx2: -r, dy2: 0, sweep: 0 },
  };
  
  const key = `${fromDir}-${toDir}`;
  const turn = turns[key];
  
  if (!turn) {
    // No turn needed (straight line or same direction)
    return `L ${cornerX} ${cornerY}`;
  }
  
  // Line to start of arc, then arc to end point
  const arcStartX = cornerX + turn.dx1;
  const arcStartY = cornerY + turn.dy1;
  const arcEndX = cornerX + turn.dx2;
  const arcEndY = cornerY + turn.dy2;
  
  return `L ${arcStartX} ${arcStartY} A ${r} ${r} 0 0 ${turn.sweep} ${arcEndX} ${arcEndY}`;
}

/**
 * Calculate SVG path for a dependency arrow with rounded corners
 * 
 * @param fromX - X position of the source (end for FS/FF, start for SS/SF)
 * @param fromY - Y center of the source bar
 * @param toX - X position of the target (start for FS/SS, end for FF/SF)
 * @param toY - Y center of the target bar
 * @param type - Dependency type
 */
export function calculateDependencyPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  type: DependencyType
): string {
  const minHorizontal = 15; // Minimum horizontal segment length
  const r = CORNER_RADIUS;
  
  // Helper to determine vertical direction
  const vDir = toY > fromY ? 'down' : 'up';

  if (type === 'FS') {
    // Finish-to-Start: most common
    if (toX > fromX + minHorizontal) {
      // Target is ahead - simple path with two turns
      const midX = fromX + (toX - fromX) / 2;
      if (Math.abs(toY - fromY) < r * 2) {
        // Not enough vertical space for rounded corners
        return `M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}`;
      }
      return `M ${fromX} ${fromY} H ${midX - r} ${roundedCorner(midX, fromY, 'right', vDir, r)} V ${toY - (toY > fromY ? r : -r)} ${roundedCorner(midX, toY, vDir, 'right', r)} H ${toX}`;
    } else {
      // Target is behind or close - route around with 4 turns
      const turnY = fromY + (toY > fromY ? 20 : -20);
      const leftX = Math.min(fromX, toX) - minHorizontal;
      const exitX = fromX + minHorizontal;
      
      if (Math.abs(turnY - fromY) < r * 2 || Math.abs(toY - turnY) < r * 2) {
        return `M ${fromX} ${fromY} H ${exitX} V ${turnY} H ${leftX} V ${toY} H ${toX}`;
      }
      
      const dir1 = turnY > fromY ? 'down' : 'up';
      const dir2 = toY > turnY ? 'down' : 'up';
      
      return `M ${fromX} ${fromY} H ${exitX - r} ${roundedCorner(exitX, fromY, 'right', dir1, r)} V ${turnY - (turnY > fromY ? r : -r)} ${roundedCorner(exitX, turnY, dir1, 'left', r)} H ${leftX + r} ${roundedCorner(leftX, turnY, 'left', dir2, r)} V ${toY - (toY > turnY ? r : -r)} ${roundedCorner(leftX, toY, dir2, 'right', r)} H ${toX}`;
    }
  }

  if (type === 'SS') {
    // Start-to-Start: both from left edges
    const leftX = Math.min(fromX, toX) - minHorizontal;
    if (Math.abs(toY - fromY) < r * 2) {
      return `M ${fromX} ${fromY} H ${leftX} V ${toY} H ${toX}`;
    }
    return `M ${fromX} ${fromY} H ${leftX + r} ${roundedCorner(leftX, fromY, 'left', vDir, r)} V ${toY - (toY > fromY ? r : -r)} ${roundedCorner(leftX, toY, vDir, 'right', r)} H ${toX}`;
  }

  if (type === 'FF') {
    // Finish-to-Finish: both from right edges
    const rightX = Math.max(fromX, toX) + minHorizontal;
    if (Math.abs(toY - fromY) < r * 2) {
      return `M ${fromX} ${fromY} H ${rightX} V ${toY} H ${toX}`;
    }
    return `M ${fromX} ${fromY} H ${rightX - r} ${roundedCorner(rightX, fromY, 'right', vDir, r)} V ${toY - (toY > fromY ? r : -r)} ${roundedCorner(rightX, toY, vDir, 'left', r)} H ${toX}`;
  }

  if (type === 'SF') {
    // Start-to-Finish: from left to right (rare)
    if (toX < fromX - minHorizontal) {
      // Target end is to the left of source start
      const midX = fromX - (fromX - toX) / 2;
      if (Math.abs(toY - fromY) < r * 2) {
        return `M ${fromX} ${fromY} H ${midX} V ${toY} H ${toX}`;
      }
      return `M ${fromX} ${fromY} H ${midX + r} ${roundedCorner(midX, fromY, 'left', vDir, r)} V ${toY - (toY > fromY ? r : -r)} ${roundedCorner(midX, toY, vDir, 'left', r)} H ${toX}`;
    } else {
      // Need to route around
      const leftX = Math.min(fromX, toX) - minHorizontal;
      const rightX = Math.max(fromX, toX) + minHorizontal;
      const turnY = fromY + (toY > fromY ? 20 : -20);
      return `M ${fromX} ${fromY} H ${leftX} V ${turnY} H ${rightX} V ${toY} H ${toX}`;
    }
  }

  // Default fallback
  return `M ${fromX} ${fromY} L ${toX} ${toY}`;
}

/**
 * Determine which edge to use for source/target based on dependency type
 */
export function getDependencyEdges(type: DependencyType): {
  sourceEdge: 'start' | 'end';
  targetEdge: 'start' | 'end';
} {
  switch (type) {
    case 'FS':
      return { sourceEdge: 'end', targetEdge: 'start' };
    case 'SS':
      return { sourceEdge: 'start', targetEdge: 'start' };
    case 'FF':
      return { sourceEdge: 'end', targetEdge: 'end' };
    case 'SF':
      return { sourceEdge: 'start', targetEdge: 'end' };
    default:
      return { sourceEdge: 'end', targetEdge: 'start' };
  }
}

/**
 * Get arrow color
 * Violated dependencies are red, normal use source phase color
 */
export function getDependencyColor(isViolated: boolean = false, phaseColor?: string): string {
  if (isViolated) {
    return '#ef4444'; // Red for violated
  }
  return phaseColor || getPhaseColor();
}
