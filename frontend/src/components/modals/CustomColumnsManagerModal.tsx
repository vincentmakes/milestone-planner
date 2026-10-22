/**
 * Custom Columns Manager Modal
 * Modal for viewing, reordering, editing, and deleting custom columns
 */

import { useState, useCallback, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import {
  reorderCustomColumns,
  deleteCustomColumn,
  getCustomColumnsWithValues,
  type CustomColumn,
} from '@/api';
import { CustomColumnModal } from './CustomColumnModal';
import styles from './CustomColumnsManagerModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';
import { Icon, TrashIcon, EditIcon, DragDotsIcon, ColumnsIcon, NotesIcon, ChevronDownIcon, CheckBoxIcon, InfoIcon, PlusIcon } from '@/components/common/Icon';

interface CustomColumnsManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CustomColumnsManagerModal({
  isOpen,
  onClose,
}: CustomColumnsManagerModalProps) {
  const customColumns = useCustomColumnStore((s) => s.customColumns);
  const currentSite = useAppStore((s) => s.currentSite);
  const setCustomColumns = useCustomColumnStore((s) => s.setCustomColumns);
  const setCustomColumnValues = useCustomColumnStore((s) => s.setCustomColumnValues);
  
  const [editingColumn, setEditingColumn] = useState<CustomColumn | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<CustomColumn | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  const dragItemRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One reorder at a time: a second drop during the first would interleave
  // writes; deletes are guarded the same way.
  const reorderGuard = useSubmitGuard();
  const deleteGuard = useSubmitGuard();

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
    if (!reorderGuard.begin()) {
      setDragOverIndex(null);
      return;
    }
    setError(null);
    
    try {
      // Create new array with reordered columns
      const newColumns = [...customColumns];
      const [removed] = newColumns.splice(dragItemRef.current, 1);
      newColumns.splice(targetIndex, 0, removed);
      
      // Update locally first for responsiveness
      const updatedColumns = newColumns.map((col, idx) => ({
        ...col,
        display_order: idx,
      }));
      setCustomColumns(updatedColumns);
      
      // Persist to server in one request
      await reorderCustomColumns(newColumns.map((col) => col.id));
    } catch (err) {
      console.error('Failed to reorder columns:', err);
      setError(err instanceof Error && err.message ? err.message : 'Failed to reorder the columns');
      // Refresh to restore correct order
      await refreshColumns();
    } finally {
      setDragOverIndex(null);
      reorderGuard.end();
    }
  };

  const handleDelete = async (column: CustomColumn) => {
    // Confirm before taking the guard: a dialog left open must not block other deletes.
    const confirmed = await confirmAction({
      title: 'Delete column',
      message: `Delete column "${column.name}"? All values will be lost.`,
      destructive: true,
    });
    if (!confirmed) return;
    if (!deleteGuard.begin()) return;
    try {
      setError(null);
      await deleteCustomColumn(column.id);
      await refreshColumns();
    } catch (err) {
      console.error('Failed to delete column:', err);
      setError(err instanceof Error && err.message ? err.message : `Failed to delete the column "${column.name}"`);
    } finally {
      deleteGuard.end();
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
          <Icon icon={CheckBoxIcon} size={14} />
        );
      case 'list':
        return (
          <Icon icon={ChevronDownIcon} size={14} />
        );
      default:
        return (
          <Icon icon={NotesIcon} size={14} />
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
        // While the nested add/edit dialog is open, Escape belongs to it:
        // one Escape must not close both dialogs.
        closeOnEscape={!editingColumn && !showAddModal}
      >
        <div className={styles.content}>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          {customColumns.length === 0 ? (
            <div className={styles.empty}>
              <Icon icon={ColumnsIcon} size={48} />
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
                  draggable={!reorderGuard.isSubmitting}
                  onDragStart={(e) => handleDragStart(e, column, index)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                >
                  <span className={styles.colDrag}>
                    <Icon icon={DragDotsIcon} size={16} />
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
                      <Icon icon={EditIcon} size={14} />
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.deleteBtn}`}
                      onClick={() => handleDelete(column)}
                      disabled={deleteGuard.isSubmitting}
                      title="Delete column"
                    >
                      <Icon icon={TrashIcon} size={14} />
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
              <Icon icon={PlusIcon} size={14} />
              Add Column
            </Button>
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.hint}>
            <Icon icon={InfoIcon} size={14} />
            Drag columns to reorder. Changes apply to phases and subphases.
          </div>
          <Button variant="secondary" onClick={onClose}>
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
