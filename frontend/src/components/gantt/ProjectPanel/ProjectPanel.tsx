/**
 * ProjectPanel
 * Left panel containing the project tree hierarchy with custom columns support
 */

import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { forwardRef, useState, useCallback, useRef, useMemo } from 'react';
import { ProjectRow } from './ProjectRow';
import { SectionRow } from './SectionRow';
import { GroupByDropdown } from './GroupByDropdown';
import { ColorByDropdown } from './ColorByDropdown';
import { flatGanttRows } from '../utils/projectSections';
import type { GanttRow } from '../utils/projectSections';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { can } from '@/utils/permissions';
import { useDataLoader } from '@/hooks';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { CustomColumnModal, CustomColumnsManagerModal } from '@/components/modals';
import { CustomColumnHeader } from '@/components/gantt/CustomColumns';
import { TagFilterDropdown } from '@/components/common/TagFilterDropdown';
import type { Project, CustomColumn } from '@/types';
import styles from './ProjectPanel.module.css';

interface ProjectPanelProps {
  /** Projects to show (already narrowed by the tag filter). */
  projects: Project[];
  /** Site projects before the tag filter; the count reads "X of Y" when they differ. */
  totalCount?: number;
  /**
   * Rows to render (Group-by sections + projects, see projectSections.ts);
   * omitted = one row per project. Must match the rows TimelineBody gets.
   */
  rows?: GanttRow[];
  /** Toggle a Group-by section (its key). */
  onToggleSection?: (key: string) => void;
  width: number;  // Width of the name/info column
  /** Omitted (e.g. while grouped) = no drag handle, no reordering. */
  onProjectReorder?: (fromId: number, targetId: number, position: 'before' | 'after') => void;
}

const noopToggle = () => {};

export const ProjectPanel = forwardRef<HTMLDivElement, ProjectPanelProps>(
  function ProjectPanel({ projects, totalCount, rows, onToggleSection, width, onProjectReorder }, ref) {
    const openProjectModal = useUIStore((s) => s.openProjectModal);
    const setActiveModal = useUIStore((s) => s.setActiveModal);
    const currentUser = useAppStore((s) => s.currentUser);
    const currentSite = useAppStore((s) => s.currentSite);
    const showAssignments = useViewStore((s) => s.showAssignments);
    const toggleShowAssignments = useViewStore((s) => s.toggleShowAssignments);
    const customColumns = useCustomColumnStore((s) => s.customColumns);
    const setCustomColumns = useCustomColumnStore((s) => s.setCustomColumns);
    const showAllCustomColumns = useCustomColumnStore((s) => s.showAllCustomColumns);
    const hiddenCustomColumns = useCustomColumnStore((s) => s.hiddenCustomColumns);
    const setShowAllCustomColumns = useCustomColumnStore((s) => s.setShowAllCustomColumns);
    const toggleCustomColumnVisibility = useCustomColumnStore((s) => s.toggleCustomColumnVisibility);
    
    const { refreshCustomColumns } = useDataLoader();
    
    const [showManagerModal, setShowManagerModal] = useState(false);
    const [showColumnModal, setShowColumnModal] = useState(false);
    const [showVisibilityDropdown, setShowVisibilityDropdown] = useState(false);
    const [editingColumn, setEditingColumn] = useState<CustomColumn | null>(null);
    const visibilityDropdownRef = useRef<HTMLDivElement>(null);
    const visibilityTriggerRef = useRef<HTMLButtonElement>(null);
    const { onBlur: onVisibilityBlur } = useDismissableOverlay({
      open: showVisibilityDropdown,
      onClose: () => setShowVisibilityDropdown(false),
      wrapperRef: visibilityDropdownRef,
      triggerRef: visibilityTriggerRef,
    });
    
    const canCreate = can(currentUser, 'projects.create');
    const canImport = can(currentUser, 'projects.import');
    // Custom-column definitions (custom_columns.manage on the backend)
    const canManageColumns = can(currentUser, 'custom_columns.manage');
    
    // Filter columns based on visibility settings
    const visibleColumns = showAllCustomColumns
      ? customColumns.filter(col => !hiddenCustomColumns.has(col.id))
      : [];
    
    const handleManageColumns = () => {
      setShowManagerModal(true);
    };
    
    const handleEditColumn = (column: CustomColumn) => {
      if (!canManageColumns) return;
      setEditingColumn(column);
      setShowColumnModal(true);
    };
    
    const handleColumnSave = () => {
      if (currentSite) {
        refreshCustomColumns(currentSite.id);
      }
    };
    
    const handleWidthChange = useCallback((columnId: number, newWidth: number) => {
      setCustomColumns(
        customColumns.map(col => 
          col.id === columnId ? { ...col, width: newWidth } : col
        )
      );
    }, [customColumns, setCustomColumns]);
    
    const handleToggleAll = () => {
      setShowAllCustomColumns(!showAllCustomColumns);
    };
    
    // Calculate total custom columns width
    const customColumnsWidth = visibleColumns.reduce((sum, col) => sum + col.width, 0);
    const totalWidth = width + customColumnsWidth;
    
    // Count hidden columns
    const hiddenCount = customColumns.length - visibleColumns.length;

    const total = totalCount ?? projects.length;
    const isTagFiltered = total !== projects.length;

    const flatRows = useMemo(() => flatGanttRows(projects), [projects]);
    const visibleRows = rows ?? flatRows;
    const toggleSection = onToggleSection ?? noopToggle;
    
    return (
      <ReorderProvider>
        <div className={styles.panel} style={{ width: totalWidth }}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerContent}>
              <div className={styles.headerLeft}>
                <span className={styles.headerTitle}>Projects</span>
                <span
                  className={styles.headerCount}
                  title={isTagFiltered ? 'Projects matching the tag filter' : undefined}
                >
                  {isTagFiltered ? `${projects.length} of ${total}` : projects.length}
                </span>
              </div>
              <div className={styles.headerActions}>
                {/* View controls */}
                <div className={styles.headerGroup}>
                  {/* Toggle staff/equipment visibility */}
                  <button 
                    className={`${styles.toggleBtn} ${!showAssignments ? styles.toggleOff : ''}`}
                    onClick={toggleShowAssignments}
                    title={showAssignments ? 'Hide Staff & Equipment' : 'Show Staff & Equipment'}
                    aria-label="Show staff and equipment"
                    aria-pressed={showAssignments}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </button>
                
                  {/* Tag filter (shared with the Kanban board, per site) */}
                  <TagFilterDropdown compact align="right" anchor="container" />

                  {/* Group the project list by a tag group (only when groups exist) */}
                  <GroupByDropdown />

                  {/* Colour the project bars by a tag group (only when groups exist) */}
                  <ColorByDropdown />

                  {/* Column visibility dropdown (only if columns exist) */}
                  {customColumns.length > 0 && (
                    <div ref={visibilityDropdownRef} className={styles.visibilityWrapper} onBlur={onVisibilityBlur}>
                      <button 
                        ref={visibilityTriggerRef}
                        type="button"
                        className={`${styles.toggleBtn} ${hiddenCount > 0 || !showAllCustomColumns ? styles.hasHidden : ''}`}
                        onClick={() => setShowVisibilityDropdown(!showVisibilityDropdown)}
                        title="Column Visibility"
                        aria-label="Column visibility"
                        aria-expanded={showVisibilityDropdown}
                        aria-haspopup="dialog"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          {showAllCustomColumns && hiddenCount === 0 ? (
                            <>
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </>
                          ) : (
                            <>
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </>
                          )}
                        </svg>
                      </button>
                    
                      {showVisibilityDropdown && (
                        <div className={styles.visibilityDropdown} role="dialog" aria-label="Column visibility">
                          <div className={styles.visibilityHeader}>
                            <span>Column Visibility</span>
                          </div>
                        
                          {/* Master toggle */}
                          <label className={`${styles.visibilityOption} ${styles.masterToggle}`}>
                            <input
                              type="checkbox"
                              checked={showAllCustomColumns}
                              onChange={handleToggleAll}
                            />
                            <span className={styles.visibilityCheckbox}>
                              <svg className={styles.visibilityCheckIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                            <span>Show All Columns</span>
                          </label>
                        
                          {showAllCustomColumns && customColumns.length > 0 && (
                            <>
                              <div className={styles.visibilityDivider} />
                              <div className={styles.visibilityList}>
                                {customColumns.map(col => (
                                  <label key={col.id} className={styles.visibilityOption}>
                                    <input
                                      type="checkbox"
                                      checked={!hiddenCustomColumns.has(col.id)}
                                      onChange={() => toggleCustomColumnVisibility(col.id)}
                                    />
                                    <span className={styles.visibilityCheckbox}>
                                      <svg className={styles.visibilityCheckIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                        <polyline points="20 6 9 17 4 12" />
                                      </svg>
                                    </span>
                                    <span>{col.name}</span>
                                  </label>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {(canCreate || canImport || canManageColumns) && (
                  <>
                    <span className={styles.headerDivider} aria-hidden="true" data-testid="header-divider" />
                    {/* Actions */}
                    <div className={styles.headerGroup}>
                      {canManageColumns && (
                        <button 
                          className={styles.columnsBtn}
                          onClick={handleManageColumns}
                          title="Manage Custom Columns"
                          aria-label="Manage custom columns"
                        >
                          {/* Table/spreadsheet icon - more explicit for columns */}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="9" y1="21" x2="9" y2="9" />
                          </svg>
                        </button>
                      )}
                      {canImport && (
                      <button 
                        className={styles.importBtn}
                        onClick={() => setActiveModal('importProject')}
                        title="Import Project"
                        aria-label="Import project"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                      </button>
                      )}
                      {canCreate && (
                      <button 
                        className={styles.newProjectBtn}
                        onClick={() => openProjectModal()}
                        title="New Project"
                        aria-label="New project"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        <span>New</span>
                      </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          
          {/* Custom Column Headers (if any) */}
          {visibleColumns.length > 0 && (
            <div className={styles.columnHeaders}>
              <div className={styles.nameColumnHeader} style={{ width }} />
              {visibleColumns.map(column => (
                <CustomColumnHeader
                  key={column.id}
                  column={column}
                  onEdit={handleEditColumn}
                  onWidthChange={handleWidthChange}
                />
              ))}
            </div>
          )}

          {/* Scrollable body */}
          <div ref={ref} className={styles.body}>
            {projects.length === 0 ? (
              <div className={styles.empty}>
                <p>{isTagFiltered ? 'No projects match the tag filter' : 'No projects found'}</p>
                <p className={styles.emptyHint}>
                  {isTagFiltered
                    ? 'Change or clear the tag filter to see more projects'
                    : canCreate ? 'Click "New" to create a project' : 'No projects available for this site'}
                </p>
              </div>
            ) : (
              visibleRows.map((row, index) =>
                row.type === 'section' ? (
                  <SectionRow
                    key={`section-${row.section.key}`}
                    section={row.section}
                    collapsed={row.collapsed}
                    onToggle={toggleSection}
                    width={width}
                  />
                ) : (
                  <ProjectRow
                    key={row.project.id}
                    project={row.project}
                    customColumns={visibleColumns}
                    nameColumnWidth={width}
                    onReorder={onProjectReorder}
                    index={index}
                  />
                )
              )
            )}
          </div>
        </div>
        
        {/* Custom Columns Manager Modal */}
        <CustomColumnsManagerModal
          isOpen={showManagerModal}
          onClose={() => setShowManagerModal(false)}
        />
        
        {/* Custom Column Edit Modal (from header click) */}
        <CustomColumnModal
          isOpen={showColumnModal}
          onClose={() => setShowColumnModal(false)}
          column={editingColumn}
          onSave={handleColumnSave}
        />
      </ReorderProvider>
    );
  }
);
