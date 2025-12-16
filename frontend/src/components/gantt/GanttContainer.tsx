/**
 * GanttContainer
 * Main container for the Gantt chart view
 * Optionally shows Staff or Equipment Overview panel below when toggled
 */

import { useRef, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ProjectPanel } from './ProjectPanel';
import { Timeline } from './Timeline';
import { useScrollSync } from './hooks/useScrollSync';
import { generateTimelineCells, generateTimelineHeaders } from './utils';
import { TimelineScrollProvider } from '@/contexts/TimelineScrollContext';
import { StaffView } from '@/components/views/StaffView/StaffView';
import { EquipmentView } from '@/components/views/EquipmentView/EquipmentView';
import styles from './GanttContainer.module.css';

export function GanttContainer() {
  const projectPanelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(320);
  const [overviewHeight, setOverviewHeight] = useState(250);

  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentDate = useAppStore((s) => s.currentDate);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const customColumns = useAppStore((s) => s.customColumns);
  const showAllCustomColumns = useAppStore((s) => s.showAllCustomColumns);
  const hiddenCustomColumns = useAppStore((s) => s.hiddenCustomColumns);
  const showStaffOverview = useAppStore((s) => s.showStaffOverview);
  const showEquipmentOverview = useAppStore((s) => s.showEquipmentOverview);
  const currentUser = useAppStore((s) => s.currentUser);

  // Only superusers/admins can see overview panels
  const canShowOverview = currentUser?.role === 'superuser' || currentUser?.role === 'admin';
  
  // Calculate visible columns
  const visibleColumns = showAllCustomColumns
    ? customColumns.filter(col => !hiddenCustomColumns.has(col.id))
    : [];

  // Filter projects for current site (non-archived) - no custom column filtering for projects
  const filteredProjects = useMemo(
    () =>
      projects
        .filter((p) => p.site_id === currentSite?.id && !p.archived)
        .sort((a, b) => {
          // Sort by confirmed status, then by name
          if (a.confirmed !== b.confirmed) {
            return a.confirmed ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        }),
    [projects, currentSite]
  );

  // Generate timeline cells
  const timelineCells = useMemo(
    () =>
      generateTimelineCells(
        currentDate,
        viewMode,
        bankHolidayDates,
        bankHolidays
      ),
    [currentDate, viewMode, bankHolidayDates, bankHolidays]
  );

  // Generate timeline headers
  const timelineHeaders = useMemo(
    () => generateTimelineHeaders(timelineCells, viewMode),
    [timelineCells, viewMode]
  );

  // Sync scroll between panels
  useScrollSync(projectPanelRef, timelineBodyRef);

  // Calculate custom columns width for staff panel alignment (only visible columns)
  const customColumnsWidth = visibleColumns.reduce((sum, col) => sum + col.width, 0);
  const totalPanelWidth = panelWidth + customColumnsWidth;

  // Handle panel resize (horizontal - width)
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Handle overview panel height resize (vertical)
  const handleVerticalResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = overviewHeight;

    const handleMouseMove = (e: MouseEvent) => {
      // Dragging up increases height, dragging down decreases
      const delta = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(500, startHeight + delta));
      setOverviewHeight(newHeight);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  // Determine which overview panel to show (only one at a time, mutual exclusivity handled in store)
  const showStaffPanel = canShowOverview && showStaffOverview;
  const showEquipmentPanel = canShowOverview && showEquipmentOverview;
  const showAnyOverview = showStaffPanel || showEquipmentPanel;
  
  // Account for the 4px resizer in total panel width
  const RESIZER_WIDTH = 4;

  const ganttContent = (
    <>
      <div className={styles.ganttArea}>
        <ProjectPanel
          ref={projectPanelRef}
          projects={filteredProjects}
          width={panelWidth}
        />
        
        <div
          className={styles.resizer}
          onMouseDown={handleResizeStart}
        />
        
        <Timeline
          ref={timelineBodyRef}
          cells={timelineCells}
          headers={timelineHeaders}
          projects={filteredProjects}
          cellWidth={cellWidth}
          viewMode={viewMode}
          hasCustomColumns={visibleColumns.length > 0}
        />
      </div>
      
      {/* Overview Panel - Staff or Equipment (only one at a time) */}
      {showAnyOverview && (
        <>
          {/* Horizontal resizer */}
          <div
            className={`${styles.horizontalResizer} ${showEquipmentPanel ? styles.equipment : ''}`}
            onMouseDown={handleVerticalResizeStart}
          />
          {showStaffPanel && (
            <StaffView 
              embedded={true} 
              panelWidth={totalPanelWidth + RESIZER_WIDTH}
              height={overviewHeight}
            />
          )}
          {showEquipmentPanel && (
            <EquipmentView 
              embedded={true} 
              panelWidth={totalPanelWidth + RESIZER_WIDTH}
              height={overviewHeight}
            />
          )}
        </>
      )}
    </>
  );

  // Always wrap with TimelineScrollProvider to maintain stable component tree
  // This prevents remounting when overview panels are toggled
  return (
    <TimelineScrollProvider>
      <div className={styles.container}>
        {ganttContent}
      </div>
    </TimelineScrollProvider>
  );
}
