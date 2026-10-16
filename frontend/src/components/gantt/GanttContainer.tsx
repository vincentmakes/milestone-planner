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
import { useScrollSync, useTagFilteredProjects } from '@/hooks';
import { useGanttGrouping } from '@/hooks/useGanttGrouping';
import { generateTimelineCells, generateTimelineHeaders } from './utils';
import { buildGanttRows, buildProjectSections, flatGanttRows } from './utils/projectSections';
import { TimelineScrollProvider } from '@/contexts/TimelineScrollContext';
import { StaffView } from '@/components/views/StaffView/StaffView';
import { EquipmentView } from '@/components/views/EquipmentView/EquipmentView';
import { orderSiteProjects, setProjectOrder, moveProjectInOrder } from '@/utils/storage';
import { canManageAnyProject } from '@/utils/permissions';
import styles from './GanttContainer.module.css';

export function GanttContainer() {
  const projectPanelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(360);
  const [overviewHeight, setOverviewHeight] = useState(250);

  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const currentUser = useAppStore((s) => s.currentUser);
  const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  const showStaffOverview = useViewStore((s) => s.showStaffOverview);
  const showEquipmentOverview = useViewStore((s) => s.showEquipmentOverview);
  const customColumns = useCustomColumnStore((s) => s.customColumns);
  const showAllCustomColumns = useCustomColumnStore((s) => s.showAllCustomColumns);
  const hiddenCustomColumns = useCustomColumnStore((s) => s.hiddenCustomColumns);

  // Overview panels exist to drag resources onto projects, so anyone who
  // manages at least one project gets them (same rule as the Header dropdown).
  const canShowOverview = canManageAnyProject(currentUser, projects);
  
  // Track project order changes to trigger re-sorting
  const [projectOrderVersion, setProjectOrderVersion] = useState(0);
  
  // Calculate visible columns
  const visibleColumns = showAllCustomColumns
    ? customColumns.filter(col => !hiddenCustomColumns.has(col.id))
    : [];

  // Filter and sort projects for current site (non-archived).
  // Shared with the Kanban board so the two views cannot drift apart.
  const filteredProjects = useMemo(
    () => orderSiteProjects(projects, currentSite?.id),
    [projects, currentSite, projectOrderVersion] // re-sort when the order changes
  );

  // Projects shown in the tree and on the timeline: the site's projects
  // narrowed by the per-site tag filter (same filter as the Kanban board).
  // Reordering still works on the full list so hidden projects keep their place.
  const visibleProjects = useTagFilteredProjects(filteredProjects);

  // "Group by tag group": the (tag-filtered) projects split into sections.
  // Both panes render the same flat row list, so they stack identically.
  const { group, siteTags, collapsedKeys, toggleSection } = useGanttGrouping();
  const ganttRows = useMemo(
    () =>
      group
        ? buildGanttRows(buildProjectSections(visibleProjects, group, siteTags), collapsedKeys)
        : flatGanttRows(visibleProjects),
    [visibleProjects, group, siteTags, collapsedKeys]
  );
  
  // Handler to reorder projects (called from ProjectPanel)
  const handleProjectReorder = useCallback((fromId: number, targetId: number, position: 'before' | 'after') => {
    if (!currentSite?.id) return;
    
    // Start from what is on screen, not the saved list: projects created since
    // the order was last saved are not in it, and must land where dropped.
    const order = moveProjectInOrder(filteredProjects.map(p => p.id), fromId, targetId, position);
    
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
        companyEvents,
        showWeekends
      ),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents, showWeekends]
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
      const newWidth = Math.max(240, Math.min(600, startWidth + delta));
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
    const constrainedWidth = Math.max(240, Math.min(600, newPanelWidth));
    setPanelWidth(constrainedWidth);
  }, [customColumnsWidth]);

  const ganttContent = (
    <>
      <div className={styles.ganttArea}>
        <ProjectPanel
          ref={projectPanelRef}
          projects={visibleProjects}
          totalCount={filteredProjects.length}
          rows={ganttRows}
          onToggleSection={toggleSection}
          width={panelWidth}
          // Sections reorder nothing: the order is per site, not per section.
          onProjectReorder={group ? undefined : handleProjectReorder}
        />
        
        <div
          className={styles.resizer}
          onMouseDown={handleResizeStart}
        />
        
        <Timeline
          ref={timelineBodyRef}
          cells={timelineCells}
          headers={timelineHeaders}
          projects={visibleProjects}
          rows={ganttRows}
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
