/**
 * Archived View
 * Shows archived projects in a Gantt timeline (same as main view but filtered)
 * Matches vanilla JS renderArchivedView()
 */

import { useMemo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync } from '@/hooks';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { TimelineRow } from './TimelineRow';
import styles from './ArchivedView.module.css';

export function ArchivedView() {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);

  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  
  const openProjectModal = useUIStore((s) => s.openProjectModal);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Get archived projects for current site
  const archivedProjects = useMemo(() => {
    return projects
      .filter((p) => p.archived && p.site_id === currentSite?.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, currentSite]);
  
  // Generate timeline data
  const cells = useMemo(() => 
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Only show weekend/holiday highlighting for week and month views
  const showHighlighting = viewMode === 'week' || viewMode === 'month';
  
  return (
    <div className={styles.container}>
      {/* Left Panel - Project List */}
      <div className={styles.projectPanel}>
        <div className={styles.panelHeader}>
          Archived Projects
        </div>
        <div className={styles.panelContent} ref={panelRef}>
          {archivedProjects.length === 0 ? (
            <div className={styles.emptyState}>
              <p>No archived projects</p>
            </div>
          ) : (
            archivedProjects.map((project) => (
              <div 
                key={project.id} 
                className={styles.projectRow}
                data-project-id={project.id}
              >
                <div className={styles.projectMain}>
                  {/* Empty expand button placeholder for alignment */}
                  <div className={styles.expandPlaceholder}>
                    <svg width="12" height="12" viewBox="0 0 24 24" />
                  </div>
                  
                  {/* Status indicator */}
                  <div className={`${styles.status} ${project.confirmed ? styles.confirmed : styles.unconfirmed}`} />
                  
                  {/* Project info */}
                  <div className={styles.projectInfo}>
                    <div className={styles.projectName}>{project.name}</div>
                    <div className={styles.projectMeta}>
                      <span className={styles.pmName}>{project.pm_name || 'No PM'}</span>
                      <span> · </span>
                      <span>{project.customer || 'No customer'}</span>
                    </div>
                  </div>
                  
                  {/* Edit button */}
                  <button 
                    className={styles.editBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      openProjectModal(project);
                    }}
                    title="Edit project"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      
      {/* Right Side - Timeline (matches Gantt Timeline structure) */}
      <div className={styles.timelineWrapper}>
        <div className={styles.timelineScroll}>
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            {/* Timeline Header */}
            <TimelineHeader
              headers={headers}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
            
            {/* Timeline Body */}
            <div className={styles.timelineBody} ref={timelineBodyRef}>
              <div 
                className={styles.timelineBodyContent}
                style={{ 
                  width: totalWidth,
                  '--cell-width': `${cellWidth}px`
                } as React.CSSProperties}
              >
                {archivedProjects.length === 0 ? (
                  <div className={styles.emptyTimeline} />
                ) : (
                  archivedProjects.map((project) => (
                    <TimelineRow
                      key={project.id}
                      project={project}
                      cells={cells}
                      cellWidth={cellWidth}
                      totalWidth={totalWidth}
                      showHighlighting={showHighlighting}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
