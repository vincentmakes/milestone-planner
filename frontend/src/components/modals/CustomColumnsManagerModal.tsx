/**
 * Custom Columns Manager Modal
 * Modal for viewing, reordering, editing, and deleting custom columns
 */

import { useState, useCallback, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useAppStore } from '@/stores/appStore';
import { 
  updateCustomColumn,
  deleteCustomColumn,
  getCustomColumnsWithValues,
  type CustomColumn,
} from '@/api';
import { CustomColumnModal } from './CustomColumnModal';
import styles from './CustomColumnsManagerModal.module.css';

interface CustomColumnsManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CustomColumnsManagerModal({ 
  isOpen, 
  onClose,
}: CustomColumnsManagerModalProps) {
  const customColumns = useAppStore((s) => s.customColumns);
  const currentSite = useAppStore((s) => s.currentSite);
  const setCustomColumns = useAppStore((s) => s.setCustomColumns);
  const setCustomColumnValues = useAppStore((s) => s.setCustomColumnValues);
  
  const [editingColumn, setEditingColumn] = useState<CustomColumn | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<CustomColumn | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  const dragItemRef = useRef<number | null>(null);

  const refreshColumns = useCallback(async () => {
    if (!currentSite) return;
    try {
      const data = await getCustomColumnsWithValues(currentSite.id);
      setCustomColumns(data.columns);
      setCustomColumnValues(data.values);
    } catch (err) {
      console.error('Failed to refresh columns:', err);
    }
  }, [currentSite, setCustomColumns, setCustomColumnValues]);

  const handleDragStart = (e: React.DragEvent, column: CustomColumn, index: number) => {
    setDraggedColumn(column);
    dragItemRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    // Set drag image (optional - makes it look better)
    const target = e.target as HTMLElement;
    target.style.opacity = '0.5';
  };

  const handleDragEnd = (e: React.DragEvent) => {
    const target = e.target as HTMLElement;
    target.style.opacity = '1';
    setDraggedColumn(null);
    setDragOverIndex(null);
    dragItemRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragItemRef.current === index) return;
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    
    if (!draggedColumn || dragItemRef.current === null || dragItemRef.current === targetIndex) {
      setDragOverIndex(null);
      return;
    }
    
    try {
      // Create new array with reordered columns
      const newColumns = [...customColumns];
      const [removed] = newColumns.splice(dragItemRef.current, 1);
      newColumns.splice(targetIndex, 0, removed);
      
      // Update display_order for all affected columns
      const updates = newColumns.map((col, idx) => ({
        id: col.id,
        display_order: idx,
      }));
      
      // Update locally first for responsiveness
      const updatedColumns = newColumns.map((col, idx) => ({
        ...col,
        display_order: idx,
      }));
      setCustomColumns(updatedColumns);
      
      // Persist to server
      for (const update of updates) {
        await updateCustomColumn(update.id, { display_order: update.display_order });
      }
    } catch (err) {
      console.error('Failed to reorder columns:', err);
      // Refresh to restore correct order
      refreshColumns();
    } finally {
      setDragOverIndex(null);
    }
  };

  const handleDelete = async (column: CustomColumn) => {
    if (!confirm(`Delete column "${column.name}"? All values will be lost.`)) {
      return;
    }

    try {
      await deleteCustomColumn(column.id);
      refreshColumns();
    } catch (err) {
      console.error('Failed to delete column:', err);
    }
  };

  const getColumnTypeLabel = (type: string) => {
    switch (type) {
      case 'boolean': return 'Checkbox';
      case 'list': return 'Dropdown';
      default: return 'Text';
    }
  };

  const getColumnTypeIcon = (type: string) => {
    switch (type) {
      case 'boolean':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        );
      case 'list':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        );
      default:
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="17" y1="10" x2="3" y2="10" />
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="21" y1="14" x2="3" y2="14" />
            <line x1="17" y1="18" x2="3" y2="18" />
          </svg>
        );
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Manage Custom Columns"
        size="lg"
      >
        <div className={styles.content}>
          {customColumns.length === 0 ? (
            <div className={styles.empty}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              <p>No custom columns yet</p>
              <span className={styles.emptyHint}>
                Add columns to track additional properties on phases and subphases
              </span>
            </div>
          ) : (
            <div className={styles.columnList}>
              <div className={styles.listHeader}>
                <span className={styles.colDrag}></span>
                <span className={styles.colName}>Name</span>
                <span className={styles.colType}>Type</span>
                <span className={styles.colScope}>Scope</span>
                <span className={styles.colWidth}>Width</span>
                <span className={styles.colActions}>Actions</span>
              </div>
              
              {customColumns.map((column, index) => (
                <div
                  key={column.id}
                  className={`${styles.columnItem} ${dragOverIndex === index ? styles.dragOver : ''} ${draggedColumn?.id === column.id ? styles.dragging : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, column, index)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                >
                  <span className={styles.colDrag}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="8" y1="6" x2="8" y2="6" />
                      <line x1="16" y1="6" x2="16" y2="6" />
                      <line x1="8" y1="12" x2="8" y2="12" />
                      <line x1="16" y1="12" x2="16" y2="12" />
                      <line x1="8" y1="18" x2="8" y2="18" />
                      <line x1="16" y1="18" x2="16" y2="18" />
                    </svg>
                  </span>
                  <span className={styles.colName}>{column.name}</span>
                  <span className={styles.colType}>
                    {getColumnTypeIcon(column.column_type)}
                    {getColumnTypeLabel(column.column_type)}
                  </span>
                  <span className={styles.colScope}>
                    {column.site_id === null ? (
                      <span className={styles.scopeGlobal}>Global</span>
                    ) : (
                      <span className={styles.scopeLocal}>Local</span>
                    )}
                  </span>
                  <span className={styles.colWidth}>{column.width}px</span>
                  <span className={styles.colActions}>
                    <button
                      className={styles.actionBtn}
                      onClick={() => setEditingColumn(column)}
                      title="Edit column"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.deleteBtn}`}
                      onClick={() => handleDelete(column)}
                      title="Delete column"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className={styles.addSection}>
            <Button 
              variant="primary"
              onClick={() => setShowAddModal(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Column
            </Button>
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.hint}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            Drag columns to reorder. Changes apply to phases and subphases.
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>

      {/* Edit column modal */}
      <CustomColumnModal
        isOpen={!!editingColumn}
        onClose={() => setEditingColumn(null)}
        column={editingColumn}
        onSave={refreshColumns}
      />

      {/* Add column modal */}
      <CustomColumnModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSave={refreshColumns}
      />
    </>
  );
}
