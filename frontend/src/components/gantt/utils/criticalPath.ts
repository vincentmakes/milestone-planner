/**
 * Critical Path Method (CPM) Calculator
 * 
 * Calculates the critical path for a project based on phases, subphases, and their dependencies.
 * The critical path is the longest path through the project network, determining the minimum
 * project duration. Items on the critical path have zero float/slack.
 */

import type { Project, Subphase, Dependency } from '@/types';

// Represents a node in the project network
interface NetworkNode {
  id: string;           // Unique identifier: 'phase-{id}' or 'subphase-{id}'
  type: 'phase' | 'subphase';
  entityId: number;     // Original phase/subphase ID
  name: string;
  startDate: Date;
  endDate: Date;
  duration: number;     // Duration in days
  dependencies: Dependency[];
  // CPM calculated values
  earlyStart: number;   // Earliest start time
  earlyFinish: number;  // Earliest finish time
  lateStart: number;    // Latest start time
  lateFinish: number;   // Latest finish time
  totalFloat: number;   // Total float/slack
}

/**
 * Calculate the duration in days between two dates
 */
function calculateDuration(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = end.getTime() - start.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1); // Include both start and end day, minimum 1 day
}

/**
 * Convert a date string to a day number (days since project start)
 */
function dateToDayNumber(dateStr: string, projectStartDate: Date): number {
  const date = new Date(dateStr);
  const diffTime = date.getTime() - projectStartDate.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Build a flat list of all phases and subphases as network nodes
 */
function buildNetworkNodes(project: Project, projectStartDate: Date): NetworkNode[] {
  const nodes: NetworkNode[] = [];
  
  // Add all phases
  for (const phase of project.phases ?? []) {
    nodes.push({
      id: `phase-${phase.id}`,
      type: 'phase',
      entityId: phase.id,
      name: phase.name,
      startDate: new Date(phase.start_date),
      endDate: new Date(phase.end_date),
      duration: calculateDuration(phase.start_date, phase.end_date),
      dependencies: phase.dependencies ?? [],
      earlyStart: dateToDayNumber(phase.start_date, projectStartDate),
      earlyFinish: 0,
      lateStart: 0,
      lateFinish: 0,
      totalFloat: 0,
    });
    
    // Recursively add subphases
    const addSubphases = (subphases: Subphase[]) => {
      for (const subphase of subphases) {
        nodes.push({
          id: `subphase-${subphase.id}`,
          type: 'subphase',
          entityId: subphase.id,
          name: subphase.name,
          startDate: new Date(subphase.start_date),
          endDate: new Date(subphase.end_date),
          duration: calculateDuration(subphase.start_date, subphase.end_date),
          dependencies: subphase.dependencies ?? [],
          earlyStart: dateToDayNumber(subphase.start_date, projectStartDate),
          earlyFinish: 0,
          lateStart: 0,
          lateFinish: 0,
          totalFloat: 0,
        });
        
        if (subphase.children?.length) {
          addSubphases(subphase.children);
        }
      }
    };
    
    if (phase.children?.length) {
      addSubphases(phase.children);
    }
  }
  
  return nodes;
}

/**
 * Perform forward pass to calculate early start and early finish times
 */
function forwardPass(nodes: NetworkNode[], nodeMap: Map<string, NetworkNode>): void {
  // Sort nodes by early start (which is initially based on actual start dates)
  const sortedNodes = [...nodes].sort((a, b) => a.earlyStart - b.earlyStart);
  
  for (const node of sortedNodes) {
    // Calculate early finish
    node.earlyFinish = node.earlyStart + node.duration - 1;
    
    // For nodes with dependencies, early start must be after all predecessors finish
    for (const dep of node.dependencies) {
      const predecessorId = `phase-${dep.id}`;
      const predecessorIdSub = `subphase-${dep.id}`;
      const predNode = nodeMap.get(predecessorId) || nodeMap.get(predecessorIdSub);
      
      if (predNode) {
        let requiredStart: number;
        const lag = dep.lag ?? 0;
        
        switch (dep.type) {
          case 'FS': // Finish-to-Start
            requiredStart = predNode.earlyFinish + 1 + lag;
            break;
          case 'SS': // Start-to-Start
            requiredStart = predNode.earlyStart + lag;
            break;
          case 'FF': // Finish-to-Finish
            requiredStart = predNode.earlyFinish - node.duration + 1 + lag;
            break;
          case 'SF': // Start-to-Finish
            requiredStart = predNode.earlyStart - node.duration + 1 + lag;
            break;
          default:
            requiredStart = predNode.earlyFinish + 1 + lag;
        }
        
        if (requiredStart > node.earlyStart) {
          node.earlyStart = requiredStart;
          node.earlyFinish = node.earlyStart + node.duration - 1;
        }
      }
    }
  }
}

/**
 * Perform backward pass to calculate late start and late finish times
 */
function backwardPass(nodes: NetworkNode[], nodeMap: Map<string, NetworkNode>, projectEndDay: number): void {
  // Initialize late finish for all nodes to project end
  for (const node of nodes) {
    node.lateFinish = projectEndDay;
    node.lateStart = node.lateFinish - node.duration + 1;
  }
  
  // Sort nodes by early finish in descending order
  const sortedNodes = [...nodes].sort((a, b) => b.earlyFinish - a.earlyFinish);
  
  // Build reverse dependency map (successor -> predecessors)
  const reverseDeps = new Map<string, Array<{ node: NetworkNode; dep: Dependency }>>();
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const predecessorId = `phase-${dep.id}`;
      const predecessorIdSub = `subphase-${dep.id}`;
      const predNode = nodeMap.get(predecessorId) || nodeMap.get(predecessorIdSub);
      
      if (predNode) {
        if (!reverseDeps.has(predNode.id)) {
          reverseDeps.set(predNode.id, []);
        }
        reverseDeps.get(predNode.id)!.push({ node, dep });
      }
    }
  }
  
  for (const node of sortedNodes) {
    // Find all successors and adjust late finish
    const successors = reverseDeps.get(node.id) || [];
    
    for (const { node: succNode, dep } of successors) {
      let requiredFinish: number;
      const lag = dep.lag ?? 0;
      
      switch (dep.type) {
        case 'FS': // Finish-to-Start
          requiredFinish = succNode.lateStart - 1 - lag;
          break;
        case 'SS': // Start-to-Start
          requiredFinish = succNode.lateStart + node.duration - 1 - lag;
          break;
        case 'FF': // Finish-to-Finish
          requiredFinish = succNode.lateFinish - lag;
          break;
        case 'SF': // Start-to-Finish
          requiredFinish = succNode.lateFinish + node.duration - 1 - lag;
          break;
        default:
          requiredFinish = succNode.lateStart - 1 - lag;
      }
      
      if (requiredFinish < node.lateFinish) {
        node.lateFinish = requiredFinish;
        node.lateStart = node.lateFinish - node.duration + 1;
      }
    }
  }
}

/**
 * Calculate total float for each node
 * Float = Late Start - Early Start (or Late Finish - Early Finish)
 */
function calculateFloat(nodes: NetworkNode[]): void {
  for (const node of nodes) {
    node.totalFloat = node.lateStart - node.earlyStart;
  }
}

/**
 * Identify critical path items (those with zero or near-zero float)
 */
function identifyCriticalPath(nodes: NetworkNode[]): Set<string> {
  const criticalItems = new Set<string>();
  
  // Items with float <= 0 are on the critical path
  // We use <= 0 to account for any rounding issues
  for (const node of nodes) {
    if (node.totalFloat <= 0) {
      criticalItems.add(node.id);
    }
  }
  
  return criticalItems;
}

/**
 * Main function to calculate critical path for a project
 * Returns a set of item IDs that are on the critical path
 * Format: 'phase-{id}' or 'subphase-{id}'
 */
export function calculateCriticalPath(project: Project): CriticalPathResult {
  const phases = project.phases ?? [];
  
  // If no phases or no dependencies, return empty result
  if (phases.length === 0) {
    return { criticalItems: new Set(), hasDependencies: false };
  }
  
  // Check if there are any dependencies
  let hasDependencies = false;
  for (const phase of phases) {
    if (phase.dependencies?.length > 0) {
      hasDependencies = true;
      break;
    }
    const checkSubphaseDeps = (subphases: Subphase[]): boolean => {
      for (const sp of subphases) {
        if (sp.dependencies?.length > 0) return true;
        if (sp.children?.length && checkSubphaseDeps(sp.children)) return true;
      }
      return false;
    };
    if (phase.children?.length && checkSubphaseDeps(phase.children)) {
      hasDependencies = true;
      break;
    }
  }
  
  // Find project start and end dates
  let projectStartDate: Date | null = null;
  let projectEndDate: Date | null = null;
  
  for (const phase of phases) {
    const phaseStart = new Date(phase.start_date);
    const phaseEnd = new Date(phase.end_date);
    
    if (!projectStartDate || phaseStart < projectStartDate) {
      projectStartDate = phaseStart;
    }
    if (!projectEndDate || phaseEnd > projectEndDate) {
      projectEndDate = phaseEnd;
    }
  }
  
  if (!projectStartDate || !projectEndDate) {
    return { criticalItems: new Set(), hasDependencies };
  }
  
  // Build network nodes
  const nodes = buildNetworkNodes(project, projectStartDate);
  
  if (nodes.length === 0) {
    return { criticalItems: new Set(), hasDependencies };
  }
  
  // Create a map for quick node lookup
  const nodeMap = new Map<string, NetworkNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }
  
  // Calculate project end day number
  const projectEndDay = Math.ceil((projectEndDate.getTime() - projectStartDate.getTime()) / (1000 * 60 * 60 * 24));
  
  // Perform CPM calculations
  forwardPass(nodes, nodeMap);
  backwardPass(nodes, nodeMap, projectEndDay);
  calculateFloat(nodes);
  
  // Identify critical path
  const criticalItems = identifyCriticalPath(nodes);
  
  return { criticalItems, hasDependencies };
}

export interface CriticalPathResult {
  criticalItems: Set<string>;  // Set of 'phase-{id}' or 'subphase-{id}'
  hasDependencies: boolean;    // Whether the project has any dependencies
}

/**
 * Check if a specific phase is on the critical path
 */
export function isPhaseOnCriticalPath(phaseId: number, criticalItems: Set<string>): boolean {
  return criticalItems.has(`phase-${phaseId}`);
}

/**
 * Check if a specific subphase is on the critical path
 */
export function isSubphaseOnCriticalPath(subphaseId: number, criticalItems: Set<string>): boolean {
  return criticalItems.has(`subphase-${subphaseId}`);
}
