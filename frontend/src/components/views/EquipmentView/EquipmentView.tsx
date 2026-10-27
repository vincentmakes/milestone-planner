/**
 * Equipment View
 * Shows all equipment with their bookings on a timeline
 * Uses the same structure as GanttContainer but organized by equipment
 * Supports embedded mode for display below Gantt chart
 */

import { useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { AnchoredPanel } from '@/components/common/AnchoredPanel';

import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import {
  useScrollSync,
  useCtrlScrollZoom,
  useResourceDragDrop,
  useEquipmentOverlaps,
  useEquipmentTodayStatus,
} from '@/hooks';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useTeamFilter, useTeamFilteredCompanyEvents } from '@/hooks/useTeamFilter';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import { deleteEquipmentBlock } from '@/api';
import { can, canBookEquipmentOnAny } from '@/utils/permissions';
import { generateTimelineCells, generateTimelineHeaders, calculateTodayScrollLeft, calculateTodayCenterScrollLeft } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { OverlapWarningIcon } from '@/components/common/OverlapWarningIcon';
import { EquipmentTimelineBody } from './EquipmentTimelineBody';
import { confirmAction } from '@/utils/confirmDialog';
import { parseNameList } from '@/utils/instanceSettings';
import styles from './EquipmentView.module.css';
import { Icon, PlusIcon, CloseIcon, ChevronRightIcon, DragDotsIcon, CheckIcon, ChevronDownIcon, FilterIcon } from '@/components/common/Icon';

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

/** The admin's default types (stored JSON list) that exist among `siteTypes` */
function defaultTypeSelection(stored: string | undefined, siteTypes: readonly string[]): Set<string> {
  return new Set(parseNameList(stored).filter((type) => siteTypes.includes(type)));
}

export function EquipmentView({ embedded = false, panelWidth, onPanelWidthChange, height }: EquipmentViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  
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
  // Company events narrowed by the header team filter
  const { events: companyEvents, eventDates: companyEventDates } = useTeamFilteredCompanyEvents();
  const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  const timelineScrollLeft = useViewStore((s) => s.timelineScrollLeft);
  const setTimelineScrollLeft = useViewStore((s) => s.setTimelineScrollLeft);
  const hasRestoredScroll = useRef(false);
  const scrollSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
  const openEquipmentBlockModal = useUIStore((s) => s.openEquipmentBlockModal);
  const currentUser = useAppStore((s) => s.currentUser);
  const { equipmentMatches } = useTeamFilter();

  // Drag and drop for equipment assignment
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();

  // Refresh blocks from the API after delete
  const { refreshEquipmentBlocks } = useDataLoader();

  // Overlap detection: equipmentId -> { hasOverlap, segments }
  const overlapMap = useEquipmentOverlaps();
  // What is each equipment doing right now: 'blocked' | 'booked' | (absent = available)
  const todayStatusMap = useEquipmentTodayStatus();

  // Dragging an equipment row onto the Gantt books it on the drop target's
  // project, so it is open to anyone who may book equipment on at least one
  // project (equipment_bookings.manage, or managing one); the drop overlay
  // (ResourceDropOverlay.canDropOn) then accepts only those projects.
  // Equipment blocks (maintenance / defect windows) are not project data:
  // they need equipment_blocks.manage.
  const canBook = canBookEquipmentOnAny(currentUser, projects);
  const canManageBlocks = can(currentUser, 'equipment_blocks.manage');

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
    const confirmed = await confirmAction({
      title: 'Delete equipment block',
      message: 'Delete this equipment block?',
      destructive: true,
    });
    if (!confirmed) return;
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
  
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Get all equipment for current site (unfiltered by type, for type
  // extraction), narrowed by the header team filter
  const allSiteEquipment = useMemo(() => 
    equipment.filter((e) => e.site_id === currentSite?.id && equipmentMatches(e))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [equipment, currentSite, equipmentMatches]
  );
  
  // Extract unique equipment types
  const equipmentTypes = useMemo(() => {
    const types = new Set<string>();
    allSiteEquipment.forEach((e) => {
      if (e.type) types.add(e.type);
    });
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }, [allSiteEquipment]);

  // Type filter state. The Equipment panel below the Gantt (embedded) is
  // seeded with the admin's default types (Settings → Features & defaults)
  // found among the site's types each time it mounts, and again when the
  // site changes (each site opens with its own defaults); the standalone
  // Equipment view opens unfiltered (a site change clears its filter).
  // Changes last the session.
  const defaultTypes = useAppStore((s) => s.instanceSettings?.equipment_panel_default_types);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() =>
    embedded ? defaultTypeSelection(defaultTypes, equipmentTypes) : new Set()
  );
  const seededSiteId = useRef(currentSite?.id);
  useLayoutEffect(() => {
    if (seededSiteId.current === currentSite?.id) return;
    seededSiteId.current = currentSite?.id;
    setSelectedTypes(embedded ? defaultTypeSelection(defaultTypes, equipmentTypes) : new Set());
  }, [currentSite?.id, defaultTypes, equipmentTypes, embedded]);
  
  // Filter equipment based on selected types (show all if none selected)
  const siteEquipment = useMemo(() => {
    if (selectedTypes.size === 0) return allSiteEquipment;
    return allSiteEquipment.filter((e) => e.type && selectedTypes.has(e.type));
  }, [allSiteEquipment, selectedTypes]);
  
  const { onBlur: onFilterBlur } = useDismissableOverlay({
    open: isFilterOpen,
    onClose: () => setIsFilterOpen(false),
    wrapperRef: filterRef,
    triggerRef: filterTriggerRef,
    panelRef: filterPanelRef,
  });
  
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
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents, showWeekends),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents, showWeekends]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Scroll to today when trigger changes (only when not embedded - Gantt handles sync)
  useEffect(() => {
    if (embedded || !scrollToTodayTrigger || !timelineScrollRef.current) return;
    
    const scrollContainer = timelineScrollRef.current;
    // Centre today's cell, or the next working day on a hidden weekend day
    const scrollTo = calculateTodayCenterScrollLeft(cells, cellWidth, scrollContainer.clientWidth);
    if (scrollTo === null) return;
    scrollContainer.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, [embedded, scrollToTodayTrigger, cells, cellWidth]);

  // Position the timeline on mount (standalone only — Gantt's Timeline handles it when embedded).
  useEffect(() => {
    if (embedded || hasRestoredScroll.current) return;
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer) return;
    if (cells.length === 0) return;
    hasRestoredScroll.current = true;
    // This session's position when coming back from another view, else today.
    requestAnimationFrame(() => {
      scrollContainer.scrollLeft = timelineScrollLeft > 0
        ? timelineScrollLeft
        : calculateTodayScrollLeft(cells, cellWidth, scrollContainer.clientWidth) ?? 0;
    });
  }, [embedded, timelineScrollLeft, cells, cellWidth]);

  // Save scroll position (debounced) on every scroll, while also forwarding to the embedded sync hook.
  const handleTimelineScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    handleSyncScroll(e);
    if (embedded) return;
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer || !hasRestoredScroll.current) return;
    if (scrollSaveTimeout.current) clearTimeout(scrollSaveTimeout.current);
    scrollSaveTimeout.current = setTimeout(() => {
      setTimelineScrollLeft(scrollContainer.scrollLeft);
    }, 200);
  }, [embedded, handleSyncScroll, setTimelineScrollLeft]);

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

  // Status label / class for an equipment based on what's happening today
  const STATUS_LABEL: Record<string, string> = {
    blocked: 'Blocked',
    booked: 'In use',
    available: 'Available',
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
      className={`${styles.container} compact-ui ${embedded ? styles.embedded : ''}`}
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
            <div ref={filterRef} className={styles.filterWrapper} onBlur={onFilterBlur}>
              <button 
                ref={filterTriggerRef}
                type="button"
                className={`${styles.filterTrigger} ${selectedTypes.size > 0 ? styles.hasFilters : ''}`}
                onClick={() => setIsFilterOpen(!isFilterOpen)}
                aria-expanded={isFilterOpen}
                aria-haspopup="dialog"
              >
                <Icon icon={FilterIcon} size={14} />
                <span className={styles.filterLabel}>
                  {selectedTypes.size === 0 
                    ? 'All Types' 
                    : selectedTypes.size === 1 
                      ? Array.from(selectedTypes)[0]
                      : `${selectedTypes.size} types`}
                </span>
                <Icon icon={ChevronDownIcon} size={12} className={`${styles.chevron} ${isFilterOpen ? styles.open : ''}`} />
              </button>
              
              <AnchoredPanel
                ref={filterPanelRef}
                open={isFilterOpen}
                triggerRef={filterTriggerRef}
                align="end"
                className={styles.filterDropdown}
                role="dialog"
                aria-label="Filter equipment"
              >
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
                        <Icon icon={CheckIcon} size={12} className={styles.checkIcon} />
                      </span>
                      <span className={styles.filterOptionText}>{type}</span>
                    </label>
                  ))}
                </div>
              </AnchoredPanel>
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
              const todayStatus = todayStatusMap.get(equip.id) ?? 'available';
              const isExpanded = expandedEquipment.has(equip.id);
              const equipBookings = equipmentBookingsMap.get(equip.id) || [];
              const equipBlocks = equipmentBlocksMap.get(equip.id) || [];

              return (
                <div key={equip.id} className={styles.equipmentWrapper}>
                  <div
                    className={`${styles.equipmentRow} ${canBook ? styles.draggable : ''}`}
                    onClick={() => toggleEquipmentExpand(equip.id)}
                    draggable={canBook}
                    onDragStart={canBook ? (e) => {
                      e.stopPropagation();
                      handleDragStart(e, 'equipment', equip.id, equip.name);
                    } : undefined}
                    onDragEnd={canBook ? handleDragEnd : undefined}
                  >
                    {canBook && (
                      <div className={styles.dragHandle} title="Drag to assign">
                        <Icon icon={DragDotsIcon} size={12} />
                      </div>
                    )}
                    <div className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}>
                      <Icon icon={ChevronRightIcon} size={12} />
                    </div>
                    <div className={`${styles.status} ${styles[todayStatus]}`} title={STATUS_LABEL[todayStatus]} />
                    <div className={styles.equipmentInfo}>
                      <div className={styles.equipmentName}>
                        <span>{equip.name}</span>
                        {overlapMap.get(equip.id)?.hasOverlap && (
                          <OverlapWarningIcon
                            size={14}
                            title="This equipment has overlapping bookings or blocks"
                          />
                        )}
                      </div>
                      <div className={styles.equipmentMeta}>
                        <span>{equip.type || 'Equipment'}</span>
                        <span> · </span>
                        <span className={todayStatus === 'blocked' ? styles.metaBlocked : undefined}>
                          {STATUS_LABEL[todayStatus]}
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className={styles.expandedContent}>
                      {/* Block detail rows */}
                      {equipBlocks.map((block) => (
                        <div
                          key={`b-${block.id}`}
                          className={`${styles.detailRow} ${canManageBlocks ? styles.clickable : ''} ${styles.blockRow}`}
                          onClick={canManageBlocks ? () => openEquipmentBlockModal(block) : undefined}
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
                          {canManageBlocks && (
                            <span
                              className={styles.deleteBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteBlock(block.id);
                              }}
                              title="Delete block"
                            >
                              <Icon icon={CloseIcon} size={14} />
                            </span>
                          )}
                        </div>
                      ))}

                      {/* Add block placeholder */}
                      {canManageBlocks && (
                        <div
                          className={`${styles.detailRow} ${styles.addRow}`}
                          onClick={() => openEquipmentBlockModal(undefined, equip.id)}
                        >
                          <span className={styles.addIcon}>
                            <Icon icon={PlusIcon} size={14} />
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

                      {equipBookings.length === 0 && equipBlocks.length === 0 && !canManageBlocks && (
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
          onScroll={handleTimelineScroll}
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
              overlapMap={overlapMap}
              expandedEquipment={expandedEquipment}
              canManage={canManageBlocks}
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
