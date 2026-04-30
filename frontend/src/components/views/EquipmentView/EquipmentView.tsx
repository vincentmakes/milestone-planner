/**
 * Equipment View
 * Shows all equipment with their bookings on a timeline
 * Uses the same structure as GanttContainer but organized by equipment
 * Supports embedded mode for display below Gantt chart
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync, useCtrlScrollZoom, useResourceDragDrop } from '@/hooks';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import { deleteEquipmentBlock } from '@/api';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { EquipmentTimelineBody } from './EquipmentTimelineBody';
import styles from './EquipmentView.module.css';

// Shared row-height constants (used by EquipmentTimelineBody to keep rows in sync)
export const BASE_ROW_HEIGHT = 44;
export const DETAIL_ROW_HEIGHT = 32;

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
  const equipmentBlocks = useAppStore((s) => s.equipmentBlocks);
  const projects = useAppStore((s) => s.projects);
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  
  const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
  const openEquipmentBlockModal = useUIStore((s) => s.openEquipmentBlockModal);
  const currentUser = useAppStore((s) => s.currentUser);

  // Drag and drop for equipment assignment
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();

  // Refresh blocks from the API after delete
  const { refreshEquipmentBlocks } = useDataLoader();

  // Check if user can drag equipment to assign / manage blocks
  const canDrag = currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  // Per-row expansion state (mirrors StaffView)
  const [expandedEquipment, setExpandedEquipment] = useState<Set<number>>(new Set());
  const toggleEquipmentExpand = (id: number) => {
    setExpandedEquipment((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDeleteBlock = async (blockId: number) => {
    if (!window.confirm('Delete this equipment block?')) return;
    try {
      await deleteEquipmentBlock(blockId);
      await refreshEquipmentBlocks();
    } catch (err) {
      console.error('[EquipmentView] Failed to delete block:', err);
    }
  };
  
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

  // Build equipment blocks map (maintenance / defect periods, scoped to current site)
  const equipmentBlocksMap = useMemo(() => {
    const map = new Map<number, typeof equipmentBlocks>();
    siteEquipment.forEach((e) => map.set(e.id, []));
    equipmentBlocks.forEach((block) => {
      if (map.has(block.equipment_id)) {
        map.get(block.equipment_id)!.push(block);
      }
    });
    return map;
  }, [equipmentBlocks, siteEquipment]);

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
              const isExpanded = expandedEquipment.has(equip.id);
              const equipBookings = equipmentBookingsMap.get(equip.id) || [];
              const equipBlocks = equipmentBlocksMap.get(equip.id) || [];

              return (
                <div key={equip.id} className={styles.equipmentWrapper}>
                  <div
                    className={`${styles.equipmentRow} ${canDrag ? styles.draggable : ''}`}
                    onClick={() => toggleEquipmentExpand(equip.id)}
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
                    <div className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
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

                  {isExpanded && (
                    <div className={styles.expandedContent}>
                      {/* Block detail rows */}
                      {equipBlocks.map((block) => (
                        <div
                          key={`b-${block.id}`}
                          className={`${styles.detailRow} ${canDrag ? styles.clickable : ''} ${styles.blockRow}`}
                          onClick={canDrag ? () => openEquipmentBlockModal(block) : undefined}
                        >
                          <span className={`${styles.detailType} ${styles.block}`}>
                            {block.reason || 'Block'}
                          </span>
                          <span className={styles.detailName}>
                            {block.description || 'Blocked'}
                          </span>
                          <span className={styles.dateBadge}>
                            {formatBlockDateRange(block.start_date, block.end_date)}
                          </span>
                          {canDrag && (
                            <span
                              className={styles.deleteBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteBlock(block.id);
                              }}
                              title="Delete block"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </span>
                          )}
                        </div>
                      ))}

                      {/* Add block placeholder */}
                      {canDrag && (
                        <div
                          className={`${styles.detailRow} ${styles.addRow}`}
                          onClick={() => openEquipmentBlockModal(undefined, equip.id)}
                        >
                          <span className={styles.addIcon}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </span>
                          <span className={styles.addText}>Add block (maintenance / defect)</span>
                        </div>
                      )}

                      {/* Assignment / booking detail rows */}
                      {equipBookings.map((booking) => (
                        <div
                          key={`a-${booking.id}-${booking.level}`}
                          className={`${styles.detailRow} ${styles.assignmentRow}`}
                        >
                          <span className={`${styles.detailType} ${styles.allocation}`}>
                            {booking.level === 'phase' ? 'Phase' : 'Project'}
                          </span>
                          <span className={styles.detailName}>
                            {booking.projectName}
                            {booking.phaseName && ` › ${booking.phaseName}`}
                          </span>
                          <span className={styles.dateBadge}>
                            {formatBlockDateRange(booking.start_date, booking.end_date)}
                          </span>
                        </div>
                      ))}

                      {equipBookings.length === 0 && equipBlocks.length === 0 && !canDrag && (
                        <div className={styles.detailRow}>
                          <span className={styles.noAssignments}>No bookings or blocks</span>
                        </div>
                      )}
                    </div>
                  )}
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
              blocksMap={equipmentBlocksMap}
              expandedEquipment={expandedEquipment}
              canManage={canDrag}
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

// Compact date range formatter for detail rows ("Apr 30 → May 12, 2026")
function formatBlockDateRange(start: string, end: string): string {
  const startStr = start.substring(0, 10);
  const endStr = end.substring(0, 10);
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const startDate = new Date(sy, sm - 1, sd);
  const endDate = new Date(ey, em - 1, ed);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (startStr === endStr) {
    return `${fmt(startDate)}, ${ey}`;
  }
  return `${fmt(startDate)} → ${fmt(endDate)}, ${ey}`;
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
