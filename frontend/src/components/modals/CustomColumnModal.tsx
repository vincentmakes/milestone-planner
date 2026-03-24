/**
 * Custom Column Modal
 * Modal for creating and editing custom columns
 */

import { useState, useEffect } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { useAppStore } from '@/stores/appStore';
import { 
  createCustomColumn, 
  updateCustomColumn, 
  deleteCustomColumn,
  type CustomColumn,
  type CustomColumnCreate,
} from '@/api';
import styles from './CustomColumnModal.module.css';

interface CustomColumnModalProps {
  isOpen: boolean;
  onClose: () => void;
  column?: CustomColumn | null; // If provided, we're editing
  onSave: () => void;
}

export function CustomColumnModal({ 
  isOpen, 
  onClose, 
  column, 
  onSave 
}: CustomColumnModalProps) {
  const currentSite = useAppStore((s) => s.currentSite);
  
  const [name, setName] = useState('');
  const [columnType, setColumnType] = useState<'text' | 'boolean' | 'list'>('text');
  const [isGlobal, setIsGlobal] = useState(false);
  const [listOptions, setListOptions] = useState<string[]>(['']);
  const [width, setWidth] = useState(120);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!column;

  // Reset form when modal opens or column changes
  useEffect(() => {
    if (isOpen) {
      if (column) {
        setName(column.name);
        setColumnType(column.column_type);
        setIsGlobal(column.site_id === null);
        setListOptions(column.list_options?.length ? column.list_options : ['']);
        setWidth(column.width);
      } else {
        setName('');
        setColumnType('text');
        setIsGlobal(false);
        setListOptions(['']);
        setWidth(120);
      }
      setError(null);
    }
  }, [isOpen, column]);

  const handleAddOption = () => {
    setListOptions([...listOptions, '']);
  };

  const handleRemoveOption = (index: number) => {
    if (listOptions.length > 1) {
      setListOptions(listOptions.filter((_, i) => i !== index));
    }
  };

  const handleOptionChange = (index: number, value: string) => {
    const newOptions = [...listOptions];
    newOptions[index] = value;
    setListOptions(newOptions);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Column name is required');
      return;
    }

    if (columnType === 'list') {
      const validOptions = listOptions.filter(o => o.trim());
      if (validOptions.length === 0) {
        setError('At least one list option is required');
        return;
      }
    }

    setIsSaving(true);
    setError(null);

    try {
      if (isEditing && column) {
        // Update existing column
        await updateCustomColumn(column.id, {
          name: name.trim(),
          list_options: columnType === 'list' ? listOptions.filter(o => o.trim()) : undefined,
          width,
        });
      } else {
        // Create new column
        const data: CustomColumnCreate = {
          name: name.trim(),
          column_type: columnType,
          site_id: isGlobal ? null : currentSite?.id,
          width,
        };

        if (columnType === 'list') {
          data.list_options = listOptions.filter(o => o.trim());
        }

        await createCustomColumn(data);
      }

      onSave();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save column');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!column || !confirm('Are you sure you want to delete this column? All values will be lost.')) {
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      await deleteCustomColumn(column.id);
      onSave();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete column');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Custom Column' : 'Add Custom Column'}
      size="md"
    >
      <div className={styles.form}>
        {error && (
          <div className={styles.error}>{error}</div>
        )}

        <div className={styles.field}>
          <Input
            label="Column Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Priority, Status, Owner"
            fullWidth
          />
        </div>

        {!isEditing && (
          <>
            <div className={styles.field}>
              <Select
                label="Column Type"
                value={columnType}
                onChange={(e) => setColumnType(e.target.value as 'text' | 'boolean' | 'list')}
                options={[
                  { value: 'text', label: 'Text' },
                  { value: 'boolean', label: 'Checkbox' },
                  { value: 'list', label: 'Dropdown List' },
                ]}
                fullWidth
              />
            </div>

            <div className={styles.checkboxField}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={isGlobal}
                  onChange={(e) => setIsGlobal(e.target.checked)}
                />
                <span className={styles.checkboxText}>
                  Global column (available to all sites)
                </span>
              </label>
              <span className={styles.hint}>
                {isGlobal 
                  ? 'This column will be visible across all sites' 
                  : `This column will only be visible to ${currentSite?.name || 'this site'}`}
              </span>
            </div>
          </>
        )}

        {columnType === 'list' && (
          <div className={styles.field}>
            <label className={styles.label}>List Options</label>
            <div className={styles.listOptions}>
              {listOptions.map((option, index) => (
                <div key={index} className={styles.listOptionRow}>
                  <Input
                    value={option}
                    onChange={(e) => handleOptionChange(index, e.target.value)}
                    placeholder={`Option ${index + 1}`}
                    fullWidth
                  />
                  {listOptions.length > 1 && (
                    <button
                      type="button"
                      className={styles.removeOptionBtn}
                      onClick={() => handleRemoveOption(index)}
                      title="Remove option"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className={styles.addOptionBtn}
                onClick={handleAddOption}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Option
              </button>
            </div>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Column Width</label>
          <div className={styles.widthControl}>
            <input
              type="range"
              min="60"
              max="300"
              value={width}
              onChange={(e) => setWidth(parseInt(e.target.value))}
              className={styles.widthSlider}
            />
            <span className={styles.widthValue}>{width}px</span>
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        {isEditing && (
          <Button
            variant="danger"
            onClick={handleDelete}
            disabled={isDeleting || isSaving}
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </Button>
        )}
        <div className={styles.rightActions}>
          <Button variant="ghost" onClick={onClose} disabled={isSaving || isDeleting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isDeleting}>
            {isSaving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
