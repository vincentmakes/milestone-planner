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
import { Icon, PlusIcon, UploadIcon, ColumnsIcon, CheckIcon, UsersIcon, EyeIcon, EyeOffIcon } from '@/components/common/Icon';

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
                    <Icon icon={UsersIcon} size={14} />
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
                        <Icon icon={showAllCustomColumns && hiddenCount === 0 ? EyeIcon : EyeOffIcon} size={14} />
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
                              <Icon icon={CheckIcon} size={12} className={styles.visibilityCheckIcon} />
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
                                      <Icon icon={CheckIcon} size={12} className={styles.visibilityCheckIcon} />
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
                          <Icon icon={ColumnsIcon} size={14} />
                        </button>
                      )}
                      {canImport && (
                      <button 
                        className={styles.importBtn}
                        onClick={() => setActiveModal('importProject')}
                        title="Import Project"
                        aria-label="Import project"
                      >
                        <Icon icon={UploadIcon} size={14} />
                      </button>
                      )}
                      {canCreate && (
                      <button 
                        className={styles.newProjectBtn}
                        onClick={() => openProjectModal()}
                        title="New Project"
                        aria-label="New project"
                      >
                        <Icon icon={PlusIcon} size={14} />
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
