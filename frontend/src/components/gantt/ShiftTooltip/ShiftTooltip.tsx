/**
 * ShiftTooltip
 * Displays detailed information when hovering over a bar while holding Shift.
 * A project's rows are the ones Settings → Project fields switches on for the
 * Gantt details (`project_tooltip_rows`), in a fixed order; phases and
 * subphases always show theirs. The content is `DetailsRows`; this component
 * owns the hover tracking, the floating wrapper and the viewport clamp.
 */

import { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { Phase, Subphase, Project } from '@/types';
import styles from './ShiftTooltip.module.css';
import { selectWeekendsWorking, tooltipRowGate, type TooltipRow } from '@/utils/instanceSettings';
import { DetailsRows } from './DetailsRows';
import { phaseTooltipData, projectTooltipData, subphaseTooltipData, type TooltipData } from './tooltipData';

/** The details of the bar under the pointer, and the pointer position */
type PointedTooltip = TooltipData & { x: number; y: number };

/** Phases and subphases show all of their rows. */
const ALL_ROWS = () => true;

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
  const [tooltipData, setTooltipData] = useState<PointedTooltip | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const projects = useAppStore((s) => s.projects);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const storeTags = useAppStore((s) => s.tags);
  const instanceSettings = useAppStore((s) => s.instanceSettings);
  const projectFields = useAppStore((s) => s.projectFields);
  const weekendsWorking = useAppStore(selectWeekendsWorking);
  const currentBarRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // A project shows the rows project_tooltip_rows lists, parsed once per settings change
  const showsProjectRow: (row: TooltipRow) => boolean = useMemo(
    () => tooltipRowGate(instanceSettings),
    [instanceSettings]
  );

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
      setTooltipData({ ...phaseTooltipData(phase, project, bankHolidayDates, weekendsWorking), x, y });
    }
  }, [projects, bankHolidayDates, weekendsWorking]);

  // Show tooltip for a subphase bar
  const showSubphaseTooltip = useCallback((subphaseId: number, x: number, y: number) => {
    const context = findSubphaseContext(projects, subphaseId);
    if (context) {
      const { subphase, project, parentPhase } = context;
      setTooltipData({
        ...subphaseTooltipData(subphase, project, parentPhase, bankHolidayDates, weekendsWorking),
        x,
        y,
      });
    }
  }, [projects, bankHolidayDates, weekendsWorking]);

  // Show tooltip for a project bar
  const showProjectTooltip = useCallback((projectId: number, x: number, y: number) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;
    const data = projectTooltipData(project, {
      tags: storeTags,
      fields: projectFields,
      bankHolidayDates,
      weekendsWorking,
    });
    if (data) setTooltipData({ ...data, x, y });
  }, [projects, bankHolidayDates, storeTags, projectFields, weekendsWorking]);

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

  return (
    <div ref={tooltipRef} className={styles.tooltip}>
      <DetailsRows
        data={tooltipData}
        settings={instanceSettings}
        shows={tooltipData.type === 'project' ? showsProjectRow : ALL_ROWS}
      />
    </div>
  );
}
