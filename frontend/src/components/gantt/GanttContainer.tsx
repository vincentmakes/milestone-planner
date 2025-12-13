/**
 * GanttContainer
 * Main container for the Gantt chart view
 */

import { useRef, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ProjectPanel } from './ProjectPanel';
import { Timeline } from './Timeline';
import { useScrollSync } from './hooks/useScrollSync';
import { generateTimelineCells, generateTimelineHeaders } from './utils';
import styles from './GanttContainer.module.css';

export function GanttContainer() {
  const projectPanelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(320);

  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentDate = useAppStore((s) => s.currentDate);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);

  // Filter projects for current site (non-archived)
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

  // Handle panel resize
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

  return (
    <div className={styles.container}>
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
      />
    </div>
  );
}
