/**
 * Cross-Site View
 * Shows every visible site and its projects in a Gantt timeline,
 * with real names and customers for every site the user can see
 * Uses the same structure as GanttContainer
 */

import { useMemo, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { isBuiltInFieldHidden } from '@/utils/instanceSettings';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync, useCtrlScrollZoom } from '@/hooks';
import { useTeamFilter, useTeamFilteredCompanyEvents } from '@/hooks/useTeamFilter';
import { generateTimelineCells, generateTimelineHeaders, calculateTodayScrollLeft, calculateTodayCenterScrollLeft } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { CrossSiteTimelineBody } from './CrossSiteTimelineBody';
import styles from './CrossSiteView.module.css';

export function CrossSiteView() {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  // The sites this user may see (the server scopes the projects the same way)
  const sites = useVisibleSites();
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  // Company events narrowed by the header team filter
  const { events: companyEvents, eventDates: companyEventDates } = useTeamFilteredCompanyEvents();
  const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
  // A hidden Customer field (Settings → Project fields) is left out
  const customerHidden = useAppStore((s) => isBuiltInFieldHidden(s.instanceSettings, 'customer'));
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  
  const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
  // The header team filter belongs to the current site: it narrows that lane only.
  const { projectMatches } = useTeamFilter();
  
  // Enable Ctrl+Scroll zoom
  useCtrlScrollZoom({ containerRef: timelineScrollRef, cellWidth });
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Generate timeline data
  const cells = useMemo(() =>
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents, showWeekends),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents, showWeekends]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Scroll to today when trigger changes
  useEffect(() => {
    if (!scrollToTodayTrigger || !timelineScrollRef.current) return;
    
    const scrollContainer = timelineScrollRef.current;
    // Centre today's cell, or the next working day on a hidden weekend day
    const scrollTo = calculateTodayCenterScrollLeft(cells, cellWidth, scrollContainer.clientWidth);
    if (scrollTo === null) return;
    scrollContainer.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, [scrollToTodayTrigger, cells, cellWidth]);

  // Open on today: the timeline starts months before the current date.
  const hasPositioned = useRef(false);
  useEffect(() => {
    const scrollContainer = timelineScrollRef.current;
    if (hasPositioned.current || !scrollContainer || cells.length === 0) return;
    hasPositioned.current = true;
    requestAnimationFrame(() => {
      scrollContainer.scrollLeft =
        calculateTodayScrollLeft(cells, cellWidth, scrollContainer.clientWidth) ?? 0;
    });
  }, [cells, cellWidth]);
  
  // Group projects by site (non-archived only)
  const projectsBySite = useMemo(() => {
    const grouped = new Map<number, typeof projects>();
    
    sites.forEach((site) => {
      grouped.set(site.id, []);
    });
    
    projects.forEach((project) => {
      if (project.archived) return;
      if (project.site_id === currentSite?.id && !projectMatches(project)) return;
      const siteProjects = grouped.get(project.site_id) || [];
      siteProjects.push(project);
      grouped.set(project.site_id, siteProjects);
    });
    
    // Sort each site's projects
    grouped.forEach((siteProjects, siteId) => {
      grouped.set(siteId, siteProjects.sort((a, b) => a.name.localeCompare(b.name)));
    });
    
    return grouped;
  }, [sites, projects, currentSite?.id, projectMatches]);
  
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
          displayCustomer: customerHidden ? '' : project.customer || '',
        });
      });
    });
    
    return result;
  }, [sites, projectsBySite, currentSite, customerHidden]);
  
  return (
    <div className={styles.container}>
      {/* Left Panel */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.headerTitle}>Cross-Site Overview</span>
        </div>
        <div className={`${styles.panelBody} compact-ui`} ref={panelRef}>
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
                  className={styles.projectRow}
                >
                  <div className={`${styles.status} ${row.project!.confirmed ? styles.confirmed : styles.unconfirmed}`} />
                  <div className={styles.projectInfo}>
                    <div className={styles.projectName}>{row.project!.name}</div>
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
      <div className={`${styles.timeline} compact-ui`}>
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
import { useVisibleSites } from '@/hooks/useVisibleSites';

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
  displayCustomer: string;
}

type CrossSiteRow = CrossSiteSiteRow | CrossSiteProjectRow;

export type { CrossSiteRow, CrossSiteSiteRow, CrossSiteProjectRow };
