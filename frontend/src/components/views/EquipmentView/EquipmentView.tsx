/**
 * Equipment View
 * Shows all equipment with their bookings on a timeline
 * Uses the same structure as GanttContainer but organized by equipment
 */

import { useMemo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useScrollSync } from '@/hooks';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { EquipmentTimelineBody } from './EquipmentTimelineBody';
import styles from './EquipmentView.module.css';

export function EquipmentView() {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  
  const equipment = useAppStore((s) => s.equipment);
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentDate = useAppStore((s) => s.currentDate);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Filter equipment for current site
  const siteEquipment = useMemo(() => 
    equipment.filter((e) => e.site_id === currentSite?.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [equipment, currentSite]
  );
  
  // Generate timeline data
  const cells = useMemo(() => 
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays),
    [currentDate, viewMode, bankHolidayDates, bankHolidays]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Build equipment bookings map
  const equipmentBookingsMap = useMemo(() => {
    const map = new Map<number, EquipmentBookingWithContext[]>();
    siteEquipment.forEach((e) => map.set(e.id, []));
    
    projects.forEach((project) => {
      if (project.archived) return;
      
      // Project-level equipment assignments
      project.equipmentAssignments?.forEach((ea) => {
        const existing = map.get(ea.equipment_id) || [];
        existing.push({
          ...ea,
          projectName: project.name,
          projectId: project.id,
          level: 'project',
        });
        map.set(ea.equipment_id, existing);
      });
      
      // Phase-level equipment assignments
      project.phases?.forEach((phase) => {
        phase.equipmentAssignments?.forEach((ea) => {
          const existing = map.get(ea.equipment_id) || [];
          existing.push({
            ...ea,
            start_date: ea.start_date || phase.start_date,
            end_date: ea.end_date || phase.end_date,
            projectName: project.name,
            projectId: project.id,
            phaseName: phase.name,
            phaseId: phase.id,
            level: 'phase',
          });
          map.set(ea.equipment_id, existing);
        });
      });
    });
    
    return map;
  }, [projects, siteEquipment]);
  
  // Calculate utilization (based on number of bookings - simplified)
  const calcUtilization = (equipmentId: number): number => {
    const bookings = equipmentBookingsMap.get(equipmentId) || [];
    // Simple check: if any booking exists, show as utilized
    return bookings.length > 0 ? 100 : 0;
  };
  
  return (
    <div className={styles.container}>
      {/* Left Panel - Equipment List */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <span className={styles.headerTitle}>Equipment</span>
          <span className={styles.headerCount}>{siteEquipment.length}</span>
        </div>
        <div className={styles.panelBody} ref={panelRef}>
          {siteEquipment.length === 0 ? (
            <div className={styles.empty}>
              <p>No equipment found</p>
            </div>
          ) : (
            siteEquipment.map((equip) => {
              const utilization = calcUtilization(equip.id);
              return (
                <div key={equip.id} className={styles.equipmentRow}>
                  <div className={`${styles.status} ${utilization > 0 ? styles.booked : styles.available}`} />
                  <div className={styles.equipmentInfo}>
                    <div className={styles.equipmentName}>{equip.name}</div>
                    <div className={styles.equipmentMeta}>
                      <span>{equip.type || 'Equipment'}</span>
                      <span> · </span>
                      <span>{utilization > 0 ? 'In use' : 'Available'}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
      
      {/* Right Side - Timeline */}
      <div className={styles.timeline}>
        <div className={styles.timelineScroll}>
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            <TimelineHeader
              headers={headers}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
            <EquipmentTimelineBody
              ref={timelineBodyRef}
              equipment={siteEquipment}
              bookingsMap={equipmentBookingsMap}
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
interface EquipmentBookingWithContext {
  id: number;
  equipment_id: number;
  start_date: string;
  end_date: string;
  projectName: string;
  projectId: number;
  phaseName?: string;
  phaseId?: number;
  level: 'project' | 'phase';
}

export type { EquipmentBookingWithContext };
