/**
 * GanttContainer
 * Main container for the Gantt chart view
 * Optionally shows Staff or Equipment Overview panel below when toggled
 */

import { useRef, useMemo, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { ProjectPanel } from './ProjectPanel';
import { Timeline } from './Timeline';
import { useScrollSync } from './hooks/useScrollSync';
import { generateTimelineCells, generateTimelineHeaders } from './utils';
import { TimelineScrollProvider } from '@/contexts/TimelineScrollContext';
import { StaffView } from '@/components/views/StaffView/StaffView';
import { EquipmentView } from '@/components/views/EquipmentView/EquipmentView';
import { sortProjectsByOrder, setProjectOrder, getProjectOrder } from '@/utils/storage';
import styles from './GanttContainer.module.css';

export function GanttContainer() {
  const projectPanelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(320);
  const [overviewHeight, setOverviewHeight] = useState(250);

  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const currentUser = useAppStore((s) => s.currentUser);
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  const showStaffOverview = useViewStore((s) => s.showStaffOverview);
  const showEquipmentOverview = useViewStore((s) => s.showEquipmentOverview);
  const customColumns = useCustomColumnStore((s) => s.customColumns);
  const showAllCustomColumns = useCustomColumnStore((s) => s.showAllCustomColumns);
  const hiddenCustomColumns = useCustomColumnStore((s) => s.hiddenCustomColumns);

  // Only superusers/admins can see overview panels
  const canShowOverview = currentUser?.role === 'superuser' || currentUser?.role === 'admin';
  
  // Track project order changes to trigger re-sorting
  const [projectOrderVersion, setProjectOrderVersion] = useState(0);
  
  // Calculate visible columns
  const visibleColumns = showAllCustomColumns
    ? customColumns.filter(col => !hiddenCustomColumns.has(col.id))
    : [];

  // Filter and sort projects for current site (non-archived)
  const filteredProjects = useMemo(() => {
    if (!currentSite?.id) return [];
    
    // First filter to current site and non-archived
    const siteProjects = projects.filter((p) => p.site_id === currentSite.id && !p.archived);
    
    // Check if there's a custom order stored
    const customOrder = getProjectOrder(currentSite.id);
    
    if (customOrder.length > 0) {
      // Use custom order (sorts projects by their position in the stored order)
      return sortProjectsByOrder(siteProjects, currentSite.id);
    }
    
    // Default sort: confirmed first, then by name
    return [...siteProjects].sort((a, b) => {
      if (a.confirmed !== b.confirmed) {
        return a.confirmed ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [projects, currentSite, projectOrderVersion]); // Include projectOrderVersion to re-sort when order changes
  
  // Handler to reorder projects (called from ProjectPanel)
  const handleProjectReorder = useCallback((fromId: number, toId: number) => {
    if (!currentSite?.id) return;
    
    // Get current order (or create from filtered projects)
    let order = getProjectOrder(currentSite.id);
    if (order.length === 0) {
      // Initialize order from current filtered projects
      order = filteredProjects.map(p => p.id);
    }
    
    // Find positions
    const fromIndex = order.indexOf(fromId);
    const toIndex = order.indexOf(toId);
    
    // If project isn't in order yet (shouldn't happen), add it
    if (fromIndex === -1) {
      order.push(fromId);
    }
    
    // Move the project
    if (fromIndex !== -1 && toIndex !== -1) {
      order.splice(fromIndex, 1);
      order.splice(toIndex, 0, fromId);
    }
    
    // Save the new order
    setProjectOrder(currentSite.id, order);
    
    // Trigger re-render
    setProjectOrderVersion(v => v + 1);
  }, [currentSite, filteredProjects]);

  // Generate timeline cells
  const timelineCells = useMemo(
    () =>
      generateTimelineCells(
        currentDate,
        viewMode,
        bankHolidayDates,
        bankHolidays,
        companyEventDates,
        companyEvents
      ),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents]
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
  
  // Handle overview panel width change (from embedded StaffView/EquipmentView resizer)
  // This updates the main panel width to keep alignment
  const handleOverviewPanelWidthChange = useCallback((newTotalWidth: number) => {
    // newTotalWidth includes resizer, so subtract it and custom columns width
    const newPanelWidth = newTotalWidth - RESIZER_WIDTH - customColumnsWidth;
    const constrainedWidth = Math.max(200, Math.min(600, newPanelWidth));
    setPanelWidth(constrainedWidth);
  }, [customColumnsWidth]);

  const ganttContent = (
    <>
      <div className={styles.ganttArea}>
        <ProjectPanel
          ref={projectPanelRef}
          projects={filteredProjects}
          width={panelWidth}
          onProjectReorder={handleProjectReorder}
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
              onPanelWidthChange={handleOverviewPanelWidthChange}
              height={overviewHeight}
            />
          )}
          {showEquipmentPanel && (
            <EquipmentView 
              embedded={true} 
              panelWidth={totalPanelWidth + RESIZER_WIDTH}
              onPanelWidthChange={handleOverviewPanelWidthChange}
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
