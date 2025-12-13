/**
 * ShiftTooltip
 * Displays detailed information when hovering over a phase/subphase while holding Shift
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { differenceInDays, eachDayOfInterval, isWeekend, parseISO, format } from 'date-fns';
import type { Phase, Subphase, Project } from '@/types';
import styles from './ShiftTooltip.module.css';

interface TooltipData {
  type: 'phase' | 'subphase';
  title: string;
  projectName: string;
  parentName?: string;
  startDate: string;
  endDate: string;
  completion: number | null;
  isCalculatedCompletion: boolean;
  workDays: number;
  totalDays: number;
  holidays: number;
  x: number;
  y: number;
}

// Calculate work days excluding weekends and holidays
function calculateDurationStats(startDate: string, endDate: string, bankHolidayDates: Set<string>) {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  
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
      const start = parseISO(child.start_date);
      const end = parseISO(child.end_date);
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

// Format date range nicely
function formatDateRange(startDate: string, endDate: string): string {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  
  return `${format(start, 'MMM d, yyyy')} - ${format(end, 'MMM d, yyyy')}`;
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
  const currentBarRef = useRef<HTMLElement | null>(null);

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
        x,
        y,
      });
    }
  }, [projects, bankHolidayDates]);

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
      // The bar has data-phase-id or data-subphase-id directly on it
      const bar = target.closest('[data-phase-id], [data-subphase-id]') as HTMLElement;
      
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
      
      if (phaseId) {
        showPhaseTooltip(parseInt(phaseId), e.clientX, e.clientY);
      } else if (subphaseId) {
        showSubphaseTooltip(parseInt(subphaseId), e.clientX, e.clientY);
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isShiftHeld, tooltipData, showPhaseTooltip, showSubphaseTooltip]);

  if (!tooltipData || !isShiftHeld) return null;

  const completionText = tooltipData.completion !== null
    ? `${tooltipData.completion}%${tooltipData.isCalculatedCompletion ? ' (calc)' : ''}`
    : '—';

  // Position tooltip with offset from cursor, ensuring it stays in viewport
  const tooltipStyle: React.CSSProperties = {
    left: Math.min(tooltipData.x + 15, window.innerWidth - 280),
    top: Math.min(tooltipData.y + 15, window.innerHeight - 200),
  };

  return (
    <div className={styles.tooltip} style={tooltipStyle}>
      <div className={styles.title}>{tooltipData.title}</div>
      <div className={styles.row}>
        <span className={styles.label}>Project:</span>
        <span>{tooltipData.projectName}</span>
      </div>
      {tooltipData.parentName && (
        <div className={styles.row}>
          <span className={styles.label}>Parent:</span>
          <span>{tooltipData.parentName}</span>
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.label}>Period:</span>
        <span>{formatDateRange(tooltipData.startDate, tooltipData.endDate)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Completion:</span>
        <span>{completionText}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Work days:</span>
        <span>
          {tooltipData.workDays} days
          {tooltipData.holidays > 0 && ` (excl. ${tooltipData.holidays} hol.)`}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Total:</span>
        <span>{tooltipData.totalDays} days</span>
      </div>
    </div>
  );
}
