/**
 * Critical Path Method (CPM) Calculator
 * 
 * Calculates the critical path for a project based on phases, subphases, and their dependencies.
 * The critical path is the longest path through the project network, determining the minimum
 * project duration. Items on the critical path have zero float/slack.
 */

import type { Project, Subphase, Dependency } from '@/types';
import { parseLocalDate, daysBetweenDateStrings } from '@/utils/date';

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
  // Calendar days on the strings: `new Date('YYYY-MM-DD')` is UTC midnight
  // and shifts a day west of UTC.
  const diffDays = daysBetweenDateStrings(startDate, endDate);
  return Math.max(1, diffDays + 1); // Include both start and end day, minimum 1 day
}

/**
 * Convert a date string to a day number (days since project start)
 */
function dateToDayNumber(dateStr: string, projectStartDate: Date): number {
  const date = parseLocalDate(dateStr);
  const diffTime = date.getTime() - projectStartDate.getTime();
  // Rounded, not floored: both are local midnights, so a DST switch in
  // between makes the span 23h/25h short of whole days.
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
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
      startDate: parseLocalDate(phase.start_date),
      endDate: parseLocalDate(phase.end_date),
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
          startDate: parseLocalDate(subphase.start_date),
          endDate: parseLocalDate(subphase.end_date),
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

/** A dependency edge between two resolved network nodes */
interface NetworkEdge {
  pred: NetworkNode;
  succ: NetworkNode;
  dep: Dependency;
}

/**
 * Resolve a dependency's predecessor. Phase and subphase ids come from
 * separate sequences: an entry carrying `entity` names its predecessor's
 * kind exactly (never falling back to the other kind); legacy entries
 * without it try a phase id first (same rule as `resolveDependencyPredecessor`).
 */
function resolvePredecessor(dep: Dependency, nodeMap: Map<string, NetworkNode>): NetworkNode | undefined {
  if (dep.entity === 'phase' || dep.entity === 'subphase') {
    return nodeMap.get(`${dep.entity}-${dep.id}`);
  }
  return nodeMap.get(`phase-${dep.id}`) || nodeMap.get(`subphase-${dep.id}`);
}

/** Every resolvable dependency as a predecessor -> successor edge (self-links dropped) */
function buildEdges(nodes: NetworkNode[], nodeMap: Map<string, NetworkNode>): NetworkEdge[] {
  const edges: NetworkEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const pred = resolvePredecessor(dep, nodeMap);
      if (pred && pred !== node) edges.push({ pred, succ: node, dep });
    }
  }
  return edges;
}

/**
 * Ids of the nodes that sit on a dependency cycle (strongly connected
 * components with more than one node, Tarjan's algorithm). CPM is undefined
 * on a cycle, so these nodes are left out of the calculation.
 */
function findCycleMembers(nodes: NetworkNode[], edges: NetworkEdge[]): Set<string> {
  const successors = new Map<string, string[]>();
  for (const { pred, succ } of edges) {
    if (!successors.has(pred.id)) successors.set(pred.id, []);
    successors.get(pred.id)!.push(succ.id);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const members = new Set<string>();
  let counter = 0;

  // Iterative DFS so a long dependency chain cannot overflow the call stack
  for (const root of nodes) {
    if (index.has(root.id)) continue;
    const work: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    index.set(root.id, counter);
    lowLink.set(root.id, counter);
    counter++;
    stack.push(root.id);
    onStack.add(root.id);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succs = successors.get(frame.id) ?? [];
      if (frame.next < succs.length) {
        const w = succs[frame.next++];
        if (!index.has(w)) {
          index.set(w, counter);
          lowLink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, next: 0 });
        } else if (onStack.has(w)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id)!, index.get(w)!));
        }
        continue;
      }

      // All successors visited: close the component rooted here, if any
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].id;
        lowLink.set(parent, Math.min(lowLink.get(parent)!, lowLink.get(frame.id)!));
      }
      if (lowLink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.id);
        if (component.length > 1) component.forEach((id) => members.add(id));
      }
    }
  }

  return members;
}

/**
 * Topological order of the nodes (Kahn's algorithm). Ties are broken by
 * actual start date, then by tree order, so the result is deterministic.
 * The edges must be acyclic (cycle members removed beforehand).
 */
function topologicalOrder(nodes: NetworkNode[], edges: NetworkEdge[]): NetworkNode[] {
  const position = new Map<string, number>();
  nodes.forEach((n, i) => position.set(n.id, i));
  const byStart = (a: NetworkNode, b: NetworkNode) =>
    a.earlyStart - b.earlyStart || position.get(a.id)! - position.get(b.id)!;

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, NetworkNode[]>();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const { pred, succ } of edges) {
    inDegree.set(succ.id, (inDegree.get(succ.id) ?? 0) + 1);
    if (!outgoing.has(pred.id)) outgoing.set(pred.id, []);
    outgoing.get(pred.id)!.push(succ);
  }

  const ready = nodes.filter((n) => inDegree.get(n.id) === 0).sort(byStart);
  const order: NetworkNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    let added = false;
    for (const succ of outgoing.get(node.id) ?? []) {
      const remaining = inDegree.get(succ.id)! - 1;
      inDegree.set(succ.id, remaining);
      if (remaining === 0) {
        ready.push(succ);
        added = true;
      }
    }
    if (added) ready.sort(byStart);
  }
  return order;
}

/**
 * Forward pass over a topological order: every predecessor is final before
 * its successors are visited, so constraints propagate down whole chains.
 * Early start begins at the item's actual start date ("start no earlier
 * than") and is pushed later by its predecessors.
 */
function forwardPass(order: NetworkNode[], incoming: Map<string, NetworkEdge[]>): void {
  for (const node of order) {
    for (const { pred, dep } of incoming.get(node.id) ?? []) {
      const lag = dep.lag ?? 0;
      let requiredStart: number;

      switch (dep.type) {
        case 'SS': // Start-to-Start
          requiredStart = pred.earlyStart + lag;
          break;
        case 'FF': // Finish-to-Finish
          requiredStart = pred.earlyFinish - node.duration + 1 + lag;
          break;
        case 'SF': // Start-to-Finish
          requiredStart = pred.earlyStart - node.duration + 1 + lag;
          break;
        case 'FS': // Finish-to-Start
        default:
          requiredStart = pred.earlyFinish + 1 + lag;
      }

      if (requiredStart > node.earlyStart) {
        node.earlyStart = requiredStart;
      }
    }
    node.earlyFinish = node.earlyStart + node.duration - 1;
  }
}

/**
 * Backward pass over the reverse topological order: every successor's late
 * dates are final before its predecessors are visited.
 */
function backwardPass(order: NetworkNode[], outgoing: Map<string, NetworkEdge[]>, projectEndDay: number): void {
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    node.lateFinish = projectEndDay;

    for (const { succ, dep } of outgoing.get(node.id) ?? []) {
      const lag = dep.lag ?? 0;
      let requiredFinish: number;

      switch (dep.type) {
        case 'SS': // Start-to-Start
          requiredFinish = succ.lateStart + node.duration - 1 - lag;
          break;
        case 'FF': // Finish-to-Finish
          requiredFinish = succ.lateFinish - lag;
          break;
        case 'SF': // Start-to-Finish
          requiredFinish = succ.lateFinish + node.duration - 1 - lag;
          break;
        case 'FS': // Finish-to-Start
        default:
          requiredFinish = succ.lateStart - 1 - lag;
      }

      if (requiredFinish < node.lateFinish) {
        node.lateFinish = requiredFinish;
      }
    }
    node.lateStart = node.lateFinish - node.duration + 1;
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
    const phaseStart = parseLocalDate(phase.start_date);
    const phaseEnd = parseLocalDate(phase.end_date);
    
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
  
  // Dependency graph. Items on a dependency cycle have no defined schedule:
  // they are skipped (never critical) and their links ignored, so the passes
  // always terminate and the rest of the project is still analysed.
  const allEdges = buildEdges(nodes, nodeMap);
  const cycleMembers = findCycleMembers(nodes, allEdges);
  const scheduled = nodes.filter((n) => !cycleMembers.has(n.id));
  const edges = allEdges.filter((e) => !cycleMembers.has(e.pred.id) && !cycleMembers.has(e.succ.id));

  const incoming = new Map<string, NetworkEdge[]>();
  const outgoing = new Map<string, NetworkEdge[]>();
  for (const edge of edges) {
    if (!incoming.has(edge.succ.id)) incoming.set(edge.succ.id, []);
    incoming.get(edge.succ.id)!.push(edge);
    if (!outgoing.has(edge.pred.id)) outgoing.set(edge.pred.id, []);
    outgoing.get(edge.pred.id)!.push(edge);
  }

  const order = topologicalOrder(scheduled, edges);

  // Perform CPM calculations
  forwardPass(order, incoming);

  // The project ends at its last early finish (dependencies can push items
  // past the planned end), and never before the planned end date.
  // Rounded: both are local midnights, so a DST switch makes the span 23h/25h off whole days.
  const plannedEndDay = Math.round((projectEndDate.getTime() - projectStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const projectEndDay = order.reduce((end, n) => Math.max(end, n.earlyFinish), plannedEndDay);

  backwardPass(order, outgoing, projectEndDay);
  calculateFloat(order);
  
  // Identify critical path
  const criticalItems = identifyCriticalPath(order);
  
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
