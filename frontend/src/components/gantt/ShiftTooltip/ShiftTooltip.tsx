/**
 * ShiftTooltip
 * Displays detailed information when hovering over a bar while holding Shift.
 * A project's rows are the ones Settings → Project fields → Gantt details
 * lists (`project_tooltip_rows`), in a fixed order; phases and subphases
 * always show theirs.
 */

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { differenceInDays, eachDayOfInterval, isWeekend, format } from 'date-fns';
import type { Phase, Subphase, Project, ProjectField, Tag } from '@/types';
import styles from './ShiftTooltip.module.css';
import { parseLocalDate } from '@/utils/date';
import { barTextColor } from '@/utils/tags';
import {
  builtInFieldLabel,
  isTooltipRowShown,
  volumeDecimals,
  type TooltipRow,
} from '@/utils/instanceSettings';
import { fieldValueItems, formatFieldNumber, formatFieldValue, isDropdownField } from '@/utils/projectFields';

interface StaffInfo {
  name: string;
  allocation: number;
}

interface TooltipData {
  type: 'phase' | 'subphase' | 'project';
  title: string;
  projectName?: string;  // Only for phase/subphase
  parentName?: string;
  startDate: string;
  endDate: string;
  completion: number | null;
  isCalculatedCompletion: boolean;
  workDays: number;
  totalDays: number;
  holidays: number;
  staff: StaffInfo[];
  x: number;
  y: number;
  // Project-specific
  customer?: string | null;
  pmName?: string | null;
  salesPm?: string | null;
  volume?: number | null;
  confirmed?: boolean;
  tags?: TooltipTag[];
  /** The project's custom field values, in field order (fields without a value left out) */
  fieldRows?: TooltipFieldRow[];
}

interface TooltipFieldRow {
  id: number;
  label: string;
  /** The value as text (text, number, toggle) */
  text?: string;
  /** A dropdown value's items, drawn as pills */
  items?: TooltipTag[];
}

interface TooltipTag {
  id: number;
  label: string;
  color: string;
}

/**
 * The project's tags resolved through the store (inline project.tags can be
 * stale, e.g. in What-If), in tag order; deleted tags are dropped.
 */
function resolveTooltipTags(project: Project, tags: Tag[]): TooltipTag[] {
  const ids = new Set((project.tags ?? []).map((t) => t.id));
  if (ids.size === 0) return [];
  return tags
    .filter((t) => ids.has(t.id))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
    .map((t) => ({ id: t.id, label: t.name, color: t.color }));
}

/**
 * The project's custom field values as tooltip rows, in the store's field
 * order (the server's sort order); fields without a value are left out.
 * Which of them show is decided at render (`project_tooltip_rows`).
 */
function resolveFieldRows(project: Project, fields: ProjectField[]): TooltipFieldRow[] {
  const values = project.field_values ?? {};
  const rows: TooltipFieldRow[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (isDropdownField(field)) {
      const items = fieldValueItems(field, value);
      if (items.length) rows.push({ id: field.id, label: field.name, items });
      continue;
    }
    const text = formatFieldValue(field, value);
    if (text !== null) rows.push({ id: field.id, label: field.name, text });
  }
  return rows;
}

// Calculate work days excluding weekends and holidays
function calculateDurationStats(startDate: string, endDate: string, bankHolidayDates: Set<string>) {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  
  const totalDays = differenceInDays(end, start) + 1;
  
  let workDays = 0;
  let holidays = 0;
  
  try {
    const days = eachDayOfInterval({ start, end });
    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const isBankHoliday = bankHolidayDates.has(dateStr);
      const isWeekendDay = isWeekend(day);
      
      if (isBankHoliday) {
        holidays++;
      } else if (!isWeekendDay) {
        workDays++;
      }
    }
  } catch {
    // If dates are invalid, just use total days
    workDays = totalDays;
  }
  
  return { totalDays, workDays, holidays };
}

// Recursively calculate effective completion for an item
// This mirrors the logic in PhaseRow.tsx
function getEffectiveCompletion(item: Phase | Subphase): { completion: number | null; isCalculated: boolean } {
  if (!item) return { completion: null, isCalculated: false };
  
  const children = item.children ?? [];
  
  // Check if any children have completion (direct or calculated)
  let hasChildrenWithCompletion = false;
  for (const child of children) {
    const childResult = getEffectiveCompletion(child);
    if (childResult && childResult.completion !== null) {
      hasChildrenWithCompletion = true;
      break;
    }
  }
  
  if (hasChildrenWithCompletion) {
    // Calculate weighted average from children's effective completion
    // Children without completion count as 0%
    let weightedSum = 0;
    let totalWeight = 0;
    
    for (const child of children) {
      const childResult = getEffectiveCompletion(child);
      const start = parseLocalDate(child.start_date);
      const end = parseLocalDate(child.end_date);
      const days = Math.max(1, differenceInDays(end, start) + 1);
      // Unset completion counts as 0% when at least one sibling has a value
      const completion = childResult.completion ?? 0;
      weightedSum += completion * days;
      totalWeight += days;
    }
    
    if (totalWeight > 0) {
      return { completion: Math.round(weightedSum / totalWeight), isCalculated: true };
    }
  }
  
  // No children with completion, return item's own completion
  return { completion: item.completion ?? null, isCalculated: false };
}

// Format date range nicely using browser locale
function formatDateRange(startDate: string, endDate: string): string {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

// Find project by phase ID
function findProjectByPhaseId(projects: Project[], phaseId: number): Project | null {
  return projects.find(p => (p.phases ?? []).some(ph => ph.id === phaseId)) ?? null;
}

// Find phase by ID
function findPhaseById(projects: Project[], phaseId: number): Phase | null {
  for (const project of projects) {
    const phase = (project.phases ?? []).find(ph => ph.id === phaseId);
    if (phase) return phase;
  }
  return null;
}

// Find subphase and its context
function findSubphaseContext(projects: Project[], subphaseId: number): { 
  subphase: Subphase; 
  project: Project; 
  parentPhase: Phase;
} | null {
  for (const project of projects) {
    for (const phase of (project.phases ?? [])) {
      const found = findSubphaseInTree(phase.children ?? [], subphaseId);
      if (found) {
        return { subphase: found, project, parentPhase: phase };
      }
    }
  }
  return null;
}

function findSubphaseInTree(children: Subphase[], targetId: number): Subphase | null {
  for (const child of children) {
    if (child.id === targetId) return child;
    if (child.children?.length) {
      const found = findSubphaseInTree(child.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

// Check if target is in a link zone (start or end clickable areas)
function isInLinkZone(target: HTMLElement): boolean {
  // Check if the target or any parent is a link zone
  let el: HTMLElement | null = target;
  while (el) {
    if (el.classList.contains('linkZone') || 
        el.className?.includes?.('linkZone') ||
        el.getAttribute('title')?.includes('linking')) {
      return true;
    }
    // Stop at the bar element
    if (el.dataset.phaseId || el.dataset.subphaseId) {
      break;
    }
    el = el.parentElement;
  }
  return false;
}

export function ShiftTooltip() {
  const [tooltipData, setTooltipData] = useState<TooltipData | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const projects = useAppStore((s) => s.projects);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const storeTags = useAppStore((s) => s.tags);
  const instanceSettings = useAppStore((s) => s.instanceSettings);
  const projectFields = useAppStore((s) => s.projectFields);
  const currentBarRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Track shift key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setTooltipData(null);
        currentBarRef.current = null;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Show tooltip for a phase bar
  const showPhaseTooltip = useCallback((phaseId: number, x: number, y: number) => {
    const phase = findPhaseById(projects, phaseId);
    const project = findProjectByPhaseId(projects, phaseId);
    
    if (phase && project) {
      const { totalDays, workDays, holidays } = calculateDurationStats(
        phase.start_date, 
        phase.end_date, 
        bankHolidayDates
      );
      const completionResult = getEffectiveCompletion(phase);
      
      // Get staff assignments for this phase
      const staff: StaffInfo[] = (phase.staffAssignments ?? []).map(a => ({
        name: a.staff_name || `Staff #${a.staff_id}`,
        allocation: a.allocation,
      }));
      
      setTooltipData({
        type: 'phase',
        title: phase.name,
        projectName: project.name,
        startDate: phase.start_date,
        endDate: phase.end_date,
        completion: completionResult.completion,
        isCalculatedCompletion: completionResult.isCalculated,
        workDays,
        totalDays,
        holidays,
        staff,
        x,
        y,
      });
    }
  }, [projects, bankHolidayDates]);

  // Show tooltip for a subphase bar
  const showSubphaseTooltip = useCallback((subphaseId: number, x: number, y: number) => {
    const context = findSubphaseContext(projects, subphaseId);
    
    if (context) {
      const { subphase, project, parentPhase } = context;
      const { totalDays, workDays, holidays } = calculateDurationStats(
        subphase.start_date, 
        subphase.end_date, 
        bankHolidayDates
      );
      const completionResult = getEffectiveCompletion(subphase);
      
      // Get staff assignments for this subphase
      const staff: StaffInfo[] = (subphase.staffAssignments ?? []).map(a => ({
        name: a.staff_name || `Staff #${a.staff_id}`,
        allocation: a.allocation,
      }));
      
      setTooltipData({
        type: 'subphase',
        title: subphase.name,
        projectName: project.name,
        parentName: parentPhase.name,
        startDate: subphase.start_date,
        endDate: subphase.end_date,
        completion: completionResult.completion,
        isCalculatedCompletion: completionResult.isCalculated,
        workDays,
        totalDays,
        holidays,
        staff,
        x,
        y,
      });
    }
  }, [projects, bankHolidayDates]);

  // Show tooltip for a project bar
  const showProjectTooltip = useCallback((projectId: number, x: number, y: number) => {
    const project = projects.find(p => p.id === projectId);
    
    if (project) {
      // Calculate project dates from phases if not set
      const startDate = project.start_date || (project.phases?.[0]?.start_date ?? '');
      const endDate = project.end_date || (project.phases?.reduce((latest, p) => 
        p.end_date > latest ? p.end_date : latest, ''
      ) ?? '');
      
      if (!startDate || !endDate) return;
      
      const { totalDays, workDays, holidays } = calculateDurationStats(
        startDate, 
        endDate, 
        bankHolidayDates
      );
      
      // Get all staff assignments for the project (project-level)
      const staff: StaffInfo[] = (project.staffAssignments ?? []).map(a => ({
        name: a.staff_name || `Staff #${a.staff_id}`,
        allocation: a.allocation,
      }));
      
      // Calculate overall project completion from phases
      let completion: number | null = null;
      let isCalculatedCompletion = false;
      const phasesWithCompletion = (project.phases ?? []).filter(p => {
        const result = getEffectiveCompletion(p);
        return result.completion !== null;
      });
      
      if (phasesWithCompletion.length > 0) {
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (const phase of project.phases ?? []) {
          const result = getEffectiveCompletion(phase);
          const start = parseLocalDate(phase.start_date);
          const end = parseLocalDate(phase.end_date);
          const days = Math.max(1, differenceInDays(end, start) + 1);
          const comp = result.completion ?? 0;
          weightedSum += comp * days;
          totalWeight += days;
        }
        
        if (totalWeight > 0) {
          completion = Math.round(weightedSum / totalWeight);
          isCalculatedCompletion = true;
        }
      }
      
      setTooltipData({
        type: 'project',
        title: project.name,
        startDate,
        endDate,
        completion,
        isCalculatedCompletion,
        workDays,
        totalDays,
        holidays,
        staff,
        customer: project.customer,
        pmName: project.pm_name,
        salesPm: project.sales_pm,
        volume: project.volume ?? null,
        confirmed: project.confirmed,
        tags: resolveTooltipTags(project, storeTags),
        fieldRows: resolveFieldRows(project, projectFields),
        x,
        y,
      });
    }
  }, [projects, bankHolidayDates, storeTags, projectFields]);

  // Handle mouse move to track hover and update position
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isShiftHeld) {
        if (tooltipData) {
          setTooltipData(null);
          currentBarRef.current = null;
        }
        return;
      }
      
      const target = e.target as HTMLElement;
      
      // Check if we're in a link zone - don't show tooltip
      if (isInLinkZone(target)) {
        setTooltipData(null);
        currentBarRef.current = null;
        return;
      }
      
      // Find the bar element - must be a direct bar element, not just within a row
      // The bar has data-phase-id, data-subphase-id, or data-project-id directly on it
      const bar = target.closest('[data-phase-id], [data-subphase-id], [data-project-id]') as HTMLElement;
      
      if (!bar) {
        // Not over a bar, hide tooltip
        setTooltipData(null);
        currentBarRef.current = null;
        return;
      }
      
      // Make sure we're actually over the bar visually, not just in its container
      // Check if the bar has the expected bar styling (position absolute, has width)
      const barStyle = window.getComputedStyle(bar);
      const isActualBar = barStyle.position === 'absolute' || 
                          bar.classList.toString().includes('bar') ||
                          bar.classList.toString().includes('Bar');
      
      if (!isActualBar) {
        // This is probably a row element, not the actual bar
        setTooltipData(null);
        currentBarRef.current = null;
        return;
      }
      
      // Check if mouse is actually within the bar's bounding rect
      const barRect = bar.getBoundingClientRect();
      if (e.clientX < barRect.left || e.clientX > barRect.right ||
          e.clientY < barRect.top || e.clientY > barRect.bottom) {
        // Mouse is outside the bar's visual bounds
        setTooltipData(null);
        currentBarRef.current = null;
        return;
      }
      
      // Update position if over the same bar
      if (bar === currentBarRef.current && tooltipData) {
        setTooltipData(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
        return;
      }
      
      // New bar - show tooltip
      currentBarRef.current = bar;
      const phaseId = bar.dataset.phaseId;
      const subphaseId = bar.dataset.subphaseId;
      const projectId = bar.dataset.projectId;
      
      if (phaseId) {
        showPhaseTooltip(parseInt(phaseId), e.clientX, e.clientY);
      } else if (subphaseId) {
        showSubphaseTooltip(parseInt(subphaseId), e.clientX, e.clientY);
      } else if (projectId) {
        showProjectTooltip(parseInt(projectId), e.clientX, e.clientY);
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isShiftHeld, tooltipData, showPhaseTooltip, showSubphaseTooltip, showProjectTooltip]);

  // Offset from the cursor and kept inside the viewport, measured once the
  // rows are laid out (offsetWidth/Height ignore the fade-in transform). No
  // re-render per mouse move; never a negative offset.
  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el || !tooltipData) return;
    const left = Math.max(8, Math.min(tooltipData.x + 15, window.innerWidth - el.offsetWidth - 8));
    const top = Math.max(8, Math.min(tooltipData.y + 15, window.innerHeight - el.offsetHeight - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tooltipData, isShiftHeld]);

  if (!tooltipData || !isShiftHeld) return null;

  const completionText = tooltipData.completion !== null
    ? `${tooltipData.completion}%${tooltipData.isCalculatedCompletion ? ' (calc)' : ''}`
    : '—';

  const isProject = tooltipData.type === 'project';
  // A project shows the rows Gantt details lists; phases and subphases all of theirs.
  const shows = (row: TooltipRow) => !isProject || isTooltipRowShown(instanceSettings, row);
  const fieldRows = isProject ? (tooltipData.fieldRows ?? []).filter((r) => shows(r.id)) : [];

  return (
    <div ref={tooltipRef} className={styles.tooltip}>
      <div className={styles.title}>{tooltipData.title}</div>
      
      {/* Project-specific: the built-in fields, PM and tags */}
      {isProject && (
        <>
          {tooltipData.customer && shows('customer') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(instanceSettings, 'customer')}:</span>
              <span>{tooltipData.customer}</span>
            </div>
          )}
          {tooltipData.pmName && shows('pm') && (
            <div className={styles.row}>
              <span className={styles.label}>PM:</span>
              <span>{tooltipData.pmName}</span>
            </div>
          )}
          {tooltipData.salesPm && shows('sales_pm') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(instanceSettings, 'sales_pm')}:</span>
              <span>{tooltipData.salesPm}</span>
            </div>
          )}
          {tooltipData.volume != null && shows('volume') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(instanceSettings, 'volume')}:</span>
              <span>{formatFieldNumber(tooltipData.volume, volumeDecimals(instanceSettings))}</span>
            </div>
          )}
          {shows('confirmed') && (
            <div className={styles.row}>
              <span className={styles.label}>{builtInFieldLabel(instanceSettings, 'confirmed')}:</span>
              <span className={tooltipData.confirmed ? styles.confirmed : styles.unconfirmed}>
                {tooltipData.confirmed ? 'Yes' : 'No'}
              </span>
            </div>
          )}
          {tooltipData.tags && tooltipData.tags.length > 0 && shows('tags') && (
            <div className={styles.tagSection}>
              <div className={styles.tagHeader}>Tags:</div>
              <div className={styles.tagRow}>
                {tooltipData.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className={styles.tagPill}
                    style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}
                  >
                    {tag.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      
      {/* Phase/Subphase: show project name */}
      {tooltipData.type !== 'project' && tooltipData.projectName && (
        <div className={styles.row}>
          <span className={styles.label}>Project:</span>
          <span>{tooltipData.projectName}</span>
        </div>
      )}
      
      {tooltipData.parentName && (
        <div className={styles.row}>
          <span className={styles.label}>Parent:</span>
          <span>{tooltipData.parentName}</span>
        </div>
      )}
      
      {shows('period') && (
        <div className={styles.row}>
          <span className={styles.label}>Period:</span>
          <span>{formatDateRange(tooltipData.startDate, tooltipData.endDate)}</span>
        </div>
      )}
      {shows('completion') && (
        <div className={styles.row}>
          <span className={styles.label}>Completion:</span>
          <span>{completionText}</span>
        </div>
      )}
      {shows('work_days') && (
        <div className={styles.row}>
          <span className={styles.label}>Work days:</span>
          <span>
            {tooltipData.workDays} days
            {tooltipData.holidays > 0 && ` (excl. ${tooltipData.holidays} hol.)`}
          </span>
        </div>
      )}
      {shows('total_days') && (
        <div className={styles.row}>
          <span className={styles.label}>Total:</span>
          <span>{tooltipData.totalDays} days</span>
        </div>
      )}
      
      {/* Staff assignments */}
      {tooltipData.staff.length > 0 && shows('staff') && (
        <div className={styles.staffSection}>
          <div className={styles.staffHeader}>Assigned Staff:</div>
          {tooltipData.staff.map((s, i) => (
            <div key={i} className={styles.staffRow}>
              <span className={styles.staffName}>{s.name}</span>
              <span className={styles.staffAllocation}>{s.allocation}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Project: the custom fields Gantt details lists, in field order */}
      {fieldRows.length > 0 && (
        <div className={styles.fieldSection}>
          {fieldRows.map((row) => (
            <div key={row.id} className={styles.row}>
              <span className={styles.label}>{row.label}:</span>
              {row.items ? (
                <div className={styles.fieldPills}>
                  {row.items.map((item) => (
                    <span
                      key={item.id}
                      className={styles.tagPill}
                      style={{ backgroundColor: item.color, color: barTextColor(item.color) }}
                    >
                      {item.label}
                    </span>
                  ))}
                </div>
              ) : (
                <span>{row.text}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
