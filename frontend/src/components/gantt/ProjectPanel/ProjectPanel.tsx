/**
 * ProjectPanel
 * Left panel containing the project tree hierarchy with custom columns support
 */

import { forwardRef, useState, useCallback, useRef, useEffect } from 'react';
import { ProjectRow } from './ProjectRow';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { CustomColumnModal, CustomColumnsManagerModal } from '@/components/modals';
import { CustomColumnHeader } from '@/components/gantt/CustomColumns';
import type { Project, CustomColumn } from '@/types';
import styles from './ProjectPanel.module.css';

interface ProjectPanelProps {
  projects: Project[];
  width: number;  // Width of the name/info column
}

export const ProjectPanel = forwardRef<HTMLDivElement, ProjectPanelProps>(
  function ProjectPanel({ projects, width }, ref) {
    const openProjectModal = useUIStore((s) => s.openProjectModal);
    const setActiveModal = useUIStore((s) => s.setActiveModal);
    const currentUser = useAppStore((s) => s.currentUser);
    const currentSite = useAppStore((s) => s.currentSite);
    const customColumns = useAppStore((s) => s.customColumns);
    const setCustomColumns = useAppStore((s) => s.setCustomColumns);
    const showAssignments = useAppStore((s) => s.showAssignments);
    const toggleShowAssignments = useAppStore((s) => s.toggleShowAssignments);
    const showAllCustomColumns = useAppStore((s) => s.showAllCustomColumns);
    const hiddenCustomColumns = useAppStore((s) => s.hiddenCustomColumns);
    const setShowAllCustomColumns = useAppStore((s) => s.setShowAllCustomColumns);
    const toggleCustomColumnVisibility = useAppStore((s) => s.toggleCustomColumnVisibility);
    
    const { refreshCustomColumns } = useDataLoader();
    
    const [showManagerModal, setShowManagerModal] = useState(false);
    const [showColumnModal, setShowColumnModal] = useState(false);
    const [showVisibilityDropdown, setShowVisibilityDropdown] = useState(false);
    const [editingColumn, setEditingColumn] = useState<CustomColumn | null>(null);
    const visibilityDropdownRef = useRef<HTMLDivElement>(null);
    
    const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
    
    // Filter columns based on visibility settings
    const visibleColumns = showAllCustomColumns
      ? customColumns.filter(col => !hiddenCustomColumns.has(col.id))
      : [];
    
    // Close dropdown when clicking outside
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (visibilityDropdownRef.current && !visibilityDropdownRef.current.contains(e.target as Node)) {
          setShowVisibilityDropdown(false);
        }
      };
      if (showVisibilityDropdown) {
        document.addEventListener('mousedown', handleClickOutside);
      }
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showVisibilityDropdown]);
    
    const handleManageColumns = () => {
      setShowManagerModal(true);
    };
    
    const handleEditColumn = (column: CustomColumn) => {
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
    
    return (
      <ReorderProvider>
        <div className={styles.panel} style={{ width: totalWidth }}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerContent} style={{ width }}>
              <div className={styles.headerLeft}>
                <span className={styles.headerTitle}>Projects</span>
                <span className={styles.headerCount}>{projects.length}</span>
              </div>
              <div className={styles.headerActions}>
                {/* Toggle staff/equipment visibility */}
                <button 
                  className={`${styles.toggleBtn} ${!showAssignments ? styles.toggleOff : ''}`}
                  onClick={toggleShowAssignments}
                  title={showAssignments ? 'Hide Staff & Equipment' : 'Show Staff & Equipment'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </button>
                
                {/* Column visibility dropdown (only if columns exist) */}
                {customColumns.length > 0 && (
                  <div ref={visibilityDropdownRef} className={styles.visibilityWrapper}>
                    <button 
                      className={`${styles.toggleBtn} ${hiddenCount > 0 || !showAllCustomColumns ? styles.hasHidden : ''}`}
                      onClick={() => setShowVisibilityDropdown(!showVisibilityDropdown)}
                      title="Column Visibility"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                      <div className={styles.visibilityDropdown}>
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
                
                {canEdit && (
                  <>
                    <button 
                      className={styles.columnsBtn}
                      onClick={handleManageColumns}
                      title="Manage Custom Columns"
                    >
                      {/* Table/spreadsheet icon - more explicit for columns */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="9" y1="21" x2="9" y2="9" />
                      </svg>
                    </button>
                    <button 
                      className={styles.importBtn}
                      onClick={() => setActiveModal('importProject')}
                      title="Import Project"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                    </button>
                    <button 
                      className={styles.newProjectBtn}
                      onClick={() => openProjectModal()}
                      title="New Project"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>New</span>
                    </button>
                  </>
                )}
              </div>
            </div>
            {/* Custom column header placeholders in main header row */}
            {visibleColumns.length > 0 && (
              <div className={styles.headerColumns}>
                {visibleColumns.map(col => (
                  <div key={col.id} className={styles.headerColumnPlaceholder} style={{ width: col.width }} />
                ))}
              </div>
            )}
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
                <p>No projects found</p>
                <p className={styles.emptyHint}>
                  {canEdit ? 'Click "New" to create a project' : 'No projects available for this site'}
                </p>
              </div>
            ) : (
              projects.map((project) => (
                <ProjectRow 
                  key={project.id} 
                  project={project}
                  customColumns={visibleColumns}
                  nameColumnWidth={width}
                />
              ))
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
