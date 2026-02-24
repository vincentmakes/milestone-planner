/**
 * Equipment View
 * Shows all equipment with their bookings on a timeline
 * Uses the same structure as GanttContainer but organized by equipment
 * Supports embedded mode for display below Gantt chart
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync, useCtrlScrollZoom, useResourceDragDrop } from '@/hooks';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { EquipmentTimelineBody } from './EquipmentTimelineBody';
import styles from './EquipmentView.module.css';

interface EquipmentViewProps {
  /** When true, hides the main header and syncs scroll with parent Gantt */
  embedded?: boolean;
  /** Panel width when embedded (controlled by parent) */
  panelWidth?: number;
  /** Callback when panel width changes in embedded mode */
  onPanelWidthChange?: (width: number) => void;
  /** Height when embedded (controlled by parent resizer) */
  height?: number;
}

export function EquipmentView({ embedded = false, panelWidth, onPanelWidthChange, height }: EquipmentViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  
  // Local panel width state for standalone mode only
  const [localPanelWidth, setLocalPanelWidth] = useState(320);
  
  // Resizer width constant
  const RESIZER_WIDTH = 4;
  
  // Effective panel width: use prop in embedded mode, local state otherwise
  // When embedded, panelWidth includes the resizer width, so subtract it for the panel itself
  const effectivePanelWidth = embedded ? ((panelWidth || 324) - RESIZER_WIDTH) : localPanelWidth;
  
  const equipment = useAppStore((s) => s.equipment);
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
  const currentUser = useAppStore((s) => s.currentUser);
  
  // Drag and drop for equipment assignment
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();
  
  // Check if user can drag equipment to assign
  const canDrag = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Enable Ctrl+Scroll zoom (only when not embedded)
  useCtrlScrollZoom({ containerRef: timelineScrollRef, cellWidth, enabled: !embedded });
  
  // Register for scroll sync when embedded
  const { handleScroll: handleSyncScroll } = useTimelineScrollSync(
    'equipment-view',
    timelineScrollRef,
    embedded
  );
  
  // Type filter state
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Get all equipment for current site (unfiltered for type extraction)
  const allSiteEquipment = useMemo(() => 
    equipment.filter((e) => e.site_id === currentSite?.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [equipment, currentSite]
  );
  
  // Extract unique equipment types
  const equipmentTypes = useMemo(() => {
    const types = new Set<string>();
    allSiteEquipment.forEach((e) => {
      if (e.type) types.add(e.type);
    });
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [allSiteEquipment]);
  
  // Filter equipment based on selected types (show all if none selected)
  const siteEquipment = useMemo(() => {
    if (selectedTypes.size === 0) return allSiteEquipment;
    return allSiteEquipment.filter((e) => e.type && selectedTypes.has(e.type));
  }, [allSiteEquipment, selectedTypes]);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    
    if (isFilterOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isFilterOpen]);
  
  // Toggle a type selection
  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };
  
  // Select all types
  const selectAllTypes = () => {
    setSelectedTypes(new Set(equipmentTypes));
  };
  
  // Clear all selections
  const clearAllTypes = () => {
    setSelectedTypes(new Set());
  };
  
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
  
  // Scroll to today when trigger changes (only when not embedded - Gantt handles sync)
  useEffect(() => {
    if (embedded || !scrollToTodayTrigger || !timelineScrollRef.current) return;
    
    const todayIndex = cells.findIndex((cell) => cell.isToday);
    if (todayIndex === -1) return;
    
    const scrollContainer = timelineScrollRef.current;
    const containerWidth = scrollContainer.clientWidth;
    const todayPosition = todayIndex * cellWidth;
    
    // Center today in the viewport
    const scrollTo = Math.max(0, todayPosition - containerWidth / 2 + cellWidth / 2);
    scrollContainer.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, [embedded, scrollToTodayTrigger, cells, cellWidth]);
  
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
  
  // Handle panel resize (horizontal - width)
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = effectivePanelWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(200, Math.min(500, startWidth + delta));
      
      if (embedded && onPanelWidthChange) {
        // In embedded mode, notify parent
        onPanelWidthChange(newWidth);
      } else {
        // In standalone mode, update local state
        setLocalPanelWidth(newWidth);
      }
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
  
  // Determine panel style - use effective width
  const panelStyle = { width: effectivePanelWidth };
  
  // Determine container style (height when embedded)
  const containerStyle = embedded && height ? { height } : undefined;
  
  return (
    <div 
      className={`${styles.container} ${embedded ? styles.embedded : ''}`}
      style={containerStyle}
    >
      {/* Left Panel - Equipment List */}
      <div className={styles.panel} style={panelStyle}>
        <div className={styles.panelHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>Equipment Overview</span>
            <span className={styles.headerCount}>{siteEquipment.length}</span>
          </div>
          
          {/* Type Filter Dropdown */}
          {equipmentTypes.length > 0 && (
            <div ref={filterRef} className={styles.filterWrapper}>
              <button 
                className={`${styles.filterTrigger} ${selectedTypes.size > 0 ? styles.hasFilters : ''}`}
                onClick={() => setIsFilterOpen(!isFilterOpen)}
                aria-expanded={isFilterOpen}
                aria-haspopup="true"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                <span className={styles.filterLabel}>
                  {selectedTypes.size === 0 
                    ? 'All Types' 
                    : selectedTypes.size === 1 
                      ? Array.from(selectedTypes)[0]
                      : `${selectedTypes.size} types`}
                </span>
                <svg
                  className={`${styles.chevron} ${isFilterOpen ? styles.open : ''}`}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              
              {isFilterOpen && (
                <div className={styles.filterDropdown}>
                  <div className={styles.filterActions}>
                    <button 
                      className={styles.filterActionBtn}
                      onClick={selectAllTypes}
                    >
                      Select All
                    </button>
                    <button 
                      className={styles.filterActionBtn}
                      onClick={clearAllTypes}
                    >
                      Clear
                    </button>
                  </div>
                  <div className={styles.filterDivider} />
                  <div className={styles.filterOptions}>
                    {equipmentTypes.map((type) => (
                      <label key={type} className={styles.filterOption}>
                        <input
                          type="checkbox"
                          checked={selectedTypes.has(type)}
                          onChange={() => toggleType(type)}
                          className={styles.filterCheckboxInput}
                        />
                        <span className={styles.filterCheckbox}>
                          <svg
                            className={styles.checkIcon}
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                        <span className={styles.filterOptionText}>{type}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
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
                <div 
                  key={equip.id} 
                  className={`${styles.equipmentRow} ${canDrag ? styles.draggable : ''}`}
                  draggable={canDrag}
                  onDragStart={canDrag ? (e) => {
                    e.stopPropagation();
                    handleDragStart(e, 'equipment', equip.id, equip.name);
                  } : undefined}
                  onDragEnd={canDrag ? handleDragEnd : undefined}
                >
                  {canDrag && (
                    <div className={styles.dragHandle} title="Drag to assign">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="9" cy="5" r="2" />
                        <circle cx="9" cy="12" r="2" />
                        <circle cx="9" cy="19" r="2" />
                        <circle cx="15" cy="5" r="2" />
                        <circle cx="15" cy="12" r="2" />
                        <circle cx="15" cy="19" r="2" />
                      </svg>
                    </div>
                  )}
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
      
      {/* Resizer for panel width */}
      <div
        className={styles.resizer}
        onMouseDown={handleResizeStart}
      />
      
      {/* Right Side - Timeline */}
      <div className={styles.timeline}>
        {/* Purple header spacer in embedded mode - stays fixed above scroll */}
        {embedded && <div className={styles.timelineHeaderSpacer} />}
        
        <div 
          className={styles.timelineScroll} 
          ref={timelineScrollRef}
          onScroll={handleSyncScroll}
        >
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            {/* Full header when not embedded */}
            {!embedded && (
              <TimelineHeader
                headers={headers}
                cells={cells}
                cellWidth={cellWidth}
                totalWidth={totalWidth}
                viewMode={viewMode}
              />
            )}
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
