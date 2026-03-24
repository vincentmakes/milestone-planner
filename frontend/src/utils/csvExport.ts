/**
 * CSV Export Utility
 * 
 * Exports projects to CSV format compatible with Microsoft Project import.
 * 
 * MS Project CSV columns:
 * - ID: Row number
 * - Name: Task name
 * - Outline Level: Hierarchy depth (1=project, 2=phase, 3+=subphase)
 * - Start: Start date (MM/DD/YYYY format)
 * - Finish: End date (MM/DD/YYYY format)
 * - Duration: Number of days
 * - Predecessors: Dependencies in format "ID{FS|SS|FF|SF}[+/-lag]"
 * - % Complete: Completion percentage
 * - Milestone: Yes/No
 * - Notes: Additional info
 */

import type { Project, Subphase, Dependency } from '@/types';
import { format, differenceInDays, parseISO } from 'date-fns';

interface ExportRow {
  id: number;
  name: string;
  outlineLevel: number;
  start: string;
  finish: string;
  duration: string;
  predecessors: string;
  percentComplete: number;
  milestone: string;
  notes: string;
  // Internal tracking
  internalId: string; // e.g., "project-1", "phase-5", "subphase-12"
}

interface IdMapping {
  [internalId: string]: number; // maps internal ID to export row ID
}

/**
 * Format a date for MS Project (MM/DD/YYYY)
 */
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const date = parseISO(dateStr);
    return format(date, 'MM/dd/yyyy');
  } catch {
    return dateStr;
  }
}

/**
 * Calculate duration in days
 */
function calculateDuration(startDate: string | null | undefined, endDate: string | null | undefined): number {
  if (!startDate || !endDate) return 1;
  try {
    const start = parseISO(startDate);
    const end = parseISO(endDate);
    return differenceInDays(end, start) + 1; // Inclusive
  } catch {
    return 1;
  }
}

/**
 * Check if a phase/subphase is a milestone (same start and end date)
 */
function isMilestone(startDate: string | null | undefined, endDate: string | null | undefined): boolean {
  return startDate === endDate;
}

/**
 * Format predecessors for MS Project
 * The Dependency type has: id (predecessor ID), type (FS/SS/FF/SF), lag (days)
 * Format: "ID{FS|SS|FF|SF}[+/-lag]"
 * Example: "2FS", "3SS+2d", "4FF-1d"
 */
function formatPredecessors(
  dependencies: Dependency[] | undefined,
  idMapping: IdMapping
): string {
  if (!dependencies || dependencies.length === 0) return '';
  
  return dependencies
    .map(dep => {
      // The dependency.id is the predecessor's ID
      // We need to find it in our mapping
      // Since we don't know if the predecessor is a phase or subphase,
      // we try both
      const phaseKey = `phase-${dep.id}`;
      const subphaseKey = `subphase-${dep.id}`;
      
      let sourceRowId = idMapping[phaseKey] || idMapping[subphaseKey];
      if (!sourceRowId) return null;
      
      // Format: ID + Type + Lag
      let result = `${sourceRowId}${dep.type}`;
      if (dep.lag && dep.lag !== 0) {
        result += dep.lag > 0 ? `+${dep.lag}d` : `${dep.lag}d`;
      }
      return result;
    })
    .filter(Boolean)
    .join(',');
}

/**
 * Recursively process subphases
 */
function processSubphases(
  subphases: Subphase[],
  parentId: number | null,
  outlineLevel: number,
  rows: ExportRow[],
  idMapping: IdMapping
): void {
  const children = subphases.filter(s => s.parent_subphase_id === parentId);
  
  for (const subphase of children) {
    const rowId = rows.length + 1;
    const internalId = `subphase-${subphase.id}`;
    idMapping[internalId] = rowId;
    
    const milestone = isMilestone(subphase.start_date, subphase.end_date);
    
    rows.push({
      id: rowId,
      name: milestone ? `◆ ${subphase.name}` : subphase.name,
      outlineLevel,
      start: formatDate(subphase.start_date),
      finish: formatDate(subphase.end_date),
      duration: milestone ? '0d' : `${calculateDuration(subphase.start_date, subphase.end_date)}d`,
      predecessors: '', // Will be filled later
      percentComplete: subphase.completion || 0,
      milestone: milestone ? 'Yes' : 'No',
      notes: '',
      internalId,
    });
    
    // Process nested subphases
    processSubphases(subphases, subphase.id, outlineLevel + 1, rows, idMapping);
  }
}

/**
 * Collect all subphases recursively from a phase
 */
function collectAllSubphases(phase: { children?: Subphase[] }): Subphase[] {
  const result: Subphase[] = [];
  
  function collect(subphases: Subphase[] | undefined) {
    if (!subphases) return;
    for (const sub of subphases) {
      result.push(sub);
      if (sub.children) {
        collect(sub.children);
      }
    }
  }
  
  collect(phase.children);
  return result;
}

/**
 * Export projects to CSV format
 */
export function exportProjectsToCSV(projects: Project[]): string {
  const rows: ExportRow[] = [];
  const idMapping: IdMapping = {};
  
  // First pass: Create all rows and build ID mapping
  for (const project of projects) {
    // Project row
    const projectRowId = rows.length + 1;
    const projectInternalId = `project-${project.id}`;
    idMapping[projectInternalId] = projectRowId;
    
    rows.push({
      id: projectRowId,
      name: project.name,
      outlineLevel: 1,
      start: formatDate(project.start_date),
      finish: formatDate(project.end_date),
      duration: `${calculateDuration(project.start_date, project.end_date)}d`,
      predecessors: '',
      percentComplete: 0, // Calculate from phases if needed
      milestone: 'No',
      notes: [
        project.customer ? `Customer: ${project.customer}` : '',
        project.pm_name ? `PM: ${project.pm_name}` : '',
        !project.confirmed ? 'UNCONFIRMED' : '',
      ].filter(Boolean).join('; '),
      internalId: projectInternalId,
    });
    
    // Phase rows
    for (const phase of project.phases || []) {
      const phaseRowId = rows.length + 1;
      const phaseInternalId = `phase-${phase.id}`;
      idMapping[phaseInternalId] = phaseRowId;
      
      const milestone = isMilestone(phase.start_date, phase.end_date);
      
      rows.push({
        id: phaseRowId,
        name: milestone ? `◆ ${phase.name}` : phase.name,
        outlineLevel: 2,
        start: formatDate(phase.start_date),
        finish: formatDate(phase.end_date),
        duration: milestone ? '0d' : `${calculateDuration(phase.start_date, phase.end_date)}d`,
        predecessors: '', // Will be filled later
        percentComplete: phase.completion || 0,
        milestone: milestone ? 'Yes' : 'No',
        notes: '',
        internalId: phaseInternalId,
      });
      
      // Collect all subphases (flattened from hierarchy)
      const allSubphases = collectAllSubphases(phase);
      
      // Subphase rows (recursive)
      if (allSubphases.length > 0) {
        processSubphases(
          allSubphases,
          null, // Top-level subphases have no parent
          3,    // Start at outline level 3
          rows,
          idMapping
        );
      }
    }
  }
  
  // Second pass: Fill in predecessors now that all IDs are assigned
  for (const project of projects) {
    for (const phase of project.phases || []) {
      const phaseRow = rows.find(r => r.internalId === `phase-${phase.id}`);
      if (phaseRow && phase.dependencies) {
        phaseRow.predecessors = formatPredecessors(phase.dependencies, idMapping);
      }
      
      const allSubphases = collectAllSubphases(phase);
      for (const subphase of allSubphases) {
        const subRow = rows.find(r => r.internalId === `subphase-${subphase.id}`);
        if (subRow && subphase.dependencies) {
          subRow.predecessors = formatPredecessors(subphase.dependencies, idMapping);
        }
      }
    }
  }
  
  // Generate CSV
  const headers = [
    'ID',
    'Name',
    'Outline Level',
    'Start',
    'Finish',
    'Duration',
    'Predecessors',
    '% Complete',
    'Milestone',
    'Notes',
  ];
  
  const csvRows = [
    headers.join(','),
    ...rows.map(row => [
      row.id,
      `"${row.name.replace(/"/g, '""')}"`, // Escape quotes
      row.outlineLevel,
      row.start,
      row.finish,
      row.duration,
      row.predecessors,
      row.percentComplete,
      row.milestone,
      `"${row.notes.replace(/"/g, '""')}"`,
    ].join(',')),
  ];
  
  return csvRows.join('\n');
}

/**
 * Download CSV as a file
 */
export function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export and download projects
 */
export function exportAndDownload(projects: Project[], siteName?: string): void {
  const csv = exportProjectsToCSV(projects);
  const date = format(new Date(), 'yyyy-MM-dd');
  const filename = siteName 
    ? `${siteName.toLowerCase().replace(/\s+/g, '-')}-projects-${date}.csv`
    : `projects-export-${date}.csv`;
  downloadCSV(csv, filename);
}
