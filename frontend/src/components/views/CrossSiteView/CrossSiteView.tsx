/**
 * Cross-Site View
 * Shows all sites and their projects in a Gantt timeline
 * Other sites' project details are masked for confidentiality
 * Uses the same structure as GanttContainer
 */

import { useMemo, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync, useCtrlScrollZoom } from '@/hooks';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { CrossSiteTimelineBody } from './CrossSiteTimelineBody';
import styles from './CrossSiteView.module.css';

export function CrossSiteView() {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  
  const sites = useAppStore((s) => s.sites);
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentDate = useAppStore((s) => s.currentDate);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  
  const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
  
  // Enable Ctrl+Scroll zoom
  useCtrlScrollZoom({ containerRef: timelineScrollRef, cellWidth });
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
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
  
  // Scroll to today when trigger changes
  useEffect(() => {
    if (!scrollToTodayTrigger || !timelineScrollRef.current) return;
    
    const todayIndex = cells.findIndex((cell) => cell.isToday);
    if (todayIndex === -1) return;
    
    const scrollContainer = timelineScrollRef.current;
    const containerWidth = scrollContainer.clientWidth;
    const todayPosition = todayIndex * cellWidth;
    
    // Center today in the viewport
    const scrollTo = Math.max(0, todayPosition - containerWidth / 2 + cellWidth / 2);
    scrollContainer.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, [scrollToTodayTrigger, cells, cellWidth]);
  
  // Group projects by site (non-archived only)
  const projectsBySite = useMemo(() => {
    const grouped = new Map<number, typeof projects>();
    
    sites.forEach((site) => {
      grouped.set(site.id, []);
    });
    
    projects.forEach((project) => {
      if (project.archived) return;
      const siteProjects = grouped.get(project.site_id) || [];
      siteProjects.push(project);
      grouped.set(project.site_id, siteProjects);
    });
    
    // Sort each site's projects
    grouped.forEach((siteProjects, siteId) => {
      grouped.set(siteId, siteProjects.sort((a, b) => a.name.localeCompare(b.name)));
    });
    
    return grouped;
  }, [sites, projects]);
  
  // Build flat list of rows for rendering
  const rows = useMemo(() => {
    const result: CrossSiteRow[] = [];
    
    sites.forEach((site) => {
      const isCurrentSite = site.id === currentSite?.id;
      const siteProjects = projectsBySite.get(site.id) || [];
      
      // Add site header row
      result.push({
        type: 'site',
        site,
        isCurrentSite,
        projectCount: siteProjects.length,
      });
      
      // Add project rows
      siteProjects.forEach((project) => {
        result.push({
          type: 'project',
          project,
          site,
          isCurrentSite,
          // Mask details for other sites
          displayName: isCurrentSite ? project.name : 'Confidential Project',
          displayCustomer: isCurrentSite ? (project.customer || '') : '***',
        });
      });
    });
    
    return result;
  }, [sites, projectsBySite, currentSite]);
  
  return (
    <div className={styles.container}>
      {/* Left Panel */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.headerTitle}>Cross-Site Overview</span>
        </div>
        <div className={styles.panelBody} ref={panelRef}>
          {rows.map((row) => {
            if (row.type === 'site') {
              return (
                <div 
                  key={`site-${row.site.id}`}
                  className={`${styles.siteRow} ${row.isCurrentSite ? styles.currentSite : ''}`}
                >
                  <div className={`${styles.siteIndicator} ${row.isCurrentSite ? styles.current : ''}`} />
                  <div className={styles.siteInfo}>
                    <div className={styles.siteName}>{row.site.name}</div>
                    <div className={styles.siteMeta}>{row.projectCount} projects</div>
                  </div>
                </div>
              );
            } else {
              return (
                <div 
                  key={`project-${row.project!.id}`}
                  className={`${styles.projectRow} ${!row.isCurrentSite ? styles.masked : ''}`}
                >
                  <div className={`${styles.status} ${row.project!.confirmed ? styles.confirmed : styles.unconfirmed}`} />
                  <div className={styles.projectInfo}>
                    <div className={styles.projectName}>{row.displayName}</div>
                    {row.displayCustomer && (
                      <div className={styles.projectMeta}>{row.displayCustomer}</div>
                    )}
                  </div>
                </div>
              );
            }
          })}
        </div>
      </div>
      
      {/* Right Side - Timeline */}
      <div className={styles.timeline}>
        <div className={styles.timelineScroll} ref={timelineScrollRef}>
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            <TimelineHeader
              headers={headers}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
            <CrossSiteTimelineBody
              ref={timelineBodyRef}
              rows={rows}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Types
import type { Site, Project } from '@/types';

interface CrossSiteSiteRow {
  type: 'site';
  site: Site;
  isCurrentSite: boolean;
  projectCount: number;
}

interface CrossSiteProjectRow {
  type: 'project';
  project: Project;
  site: Site;
  isCurrentSite: boolean;
  displayName: string;
  displayCustomer: string;
}

type CrossSiteRow = CrossSiteSiteRow | CrossSiteProjectRow;

export type { CrossSiteRow, CrossSiteSiteRow, CrossSiteProjectRow };
