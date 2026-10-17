/**
 * CustomColumnCell Component
 * Renders the appropriate cell type based on column configuration
 * Supports: text, boolean (checkbox), and list (dropdown)
 * Features: Cascade to children on value change
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { setCustomColumnValue as setCustomColumnValueApi, setCustomColumnValuesBatch, getValueKey } from '@/api';
import type { CustomColumn, CustomColumnEntityType } from '@/types';
import styles from './CustomColumnCell.module.css';

// Child entity info for cascading values
interface ChildEntity {
  entityType: CustomColumnEntityType;
  entityId: number;
}

/** Largest batch the backend accepts in one PUT /custom-columns/values/batch */
const BATCH_LIMIT = 500;

interface CustomColumnCellProps {
  column: CustomColumn;
  entityType: CustomColumnEntityType;
  entityId: number;
  /**
   * Values are self-service: every signed-in user may edit them (the backend
   * only requires authentication). Definitions stay admin-only elsewhere.
   */
  readOnly?: boolean;
  // All descendant entities to cascade value changes to
  childEntities?: ChildEntity[];
}

export function CustomColumnCell({ 
  column, 
  entityType, 
  entityId,
  readOnly = false,
  childEntities = [],
}: CustomColumnCellProps) {
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
  const setCustomColumnValueLocal = useCustomColumnStore((s) => s.setCustomColumnValue);
  
  const valueKey = getValueKey(column.id, entityType, entityId);
  const value = customColumnValues[valueKey] ?? null;
  
  const handleChange = useCallback(async (newValue: string | null) => {
    // The entity and every descendant it cascades to, with their current
    // values so a failed save can put them back.
    const targets = [{ entityType, entityId }, ...childEntities];
    const before = useCustomColumnStore.getState().customColumnValues;
    const previous = targets.map((t) => ({
      ...t,
      value: before[getValueKey(column.id, t.entityType, t.entityId)] ?? null,
    }));

    // Update local state immediately for responsiveness (entity + cascade)
    for (const t of targets) {
      setCustomColumnValueLocal(column.id, t.entityType, t.entityId, newValue);
    }

    try {
      if (childEntities.length === 0) {
        await setCustomColumnValueApi({
          custom_column_id: column.id,
          entity_type: entityType,
          entity_id: entityId,
          value: newValue,
        });
      } else {
        // One transactional request per chunk instead of N sequential PUTs:
        // a failure cannot leave half of the subtree updated (bounded by the
        // backend's batch limit; chunking only matters past it).
        const updates = targets.map((t) => ({
          custom_column_id: column.id,
          entity_type: t.entityType,
          entity_id: t.entityId,
          value: newValue,
        }));
        for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
          await setCustomColumnValuesBatch(updates.slice(i, i + BATCH_LIMIT));
        }
      }
    } catch (err) {
      console.error('[CustomColumnCell] Failed to save value, restoring the previous values:', err);
      // Roll back every cell this change touched — unless the user has
      // changed it again in the meantime.
      const now = useCustomColumnStore.getState().customColumnValues;
      for (const p of previous) {
        if ((now[getValueKey(column.id, p.entityType, p.entityId)] ?? null) === newValue) {
          setCustomColumnValueLocal(column.id, p.entityType, p.entityId, p.value);
        }
      }
    }
  }, [column.id, entityType, entityId, setCustomColumnValueLocal, childEntities]);
  
  // Render cell content based on type
  const renderCellContent = () => {
    switch (column.column_type) {
      case 'boolean':
        return (
          <BooleanCell 
            value={value} 
            onChange={handleChange} 
            readOnly={readOnly}
          />
        );
      case 'list':
        return (
          <ListCell 
            value={value} 
            options={column.list_options || []}
            onChange={handleChange}
            readOnly={readOnly}
          />
        );
      default:
        return (
          <TextCell 
            value={value} 
            onChange={handleChange}
            readOnly={readOnly}
          />
        );
    }
  };
  
  return (
    <div className={styles.cellWrapper}>
      {renderCellContent()}
    </div>
  );
}

// =============================================================================
// TEXT CELL
// =============================================================================

interface TextCellProps {
  value: string | null;
  onChange: (value: string | null) => void;
  readOnly?: boolean;
}

function TextCell({ value, onChange, readOnly }: TextCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value || '');
  const inputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);
  
  const handleClick = () => {
    if (!readOnly) {
      setEditValue(value || '');
      setIsEditing(true);
    }
  };
  
  const handleBlur = () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed !== (value || '')) {
      onChange(trimmed || null);
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(value || '');
    }
  };
  
  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        className={styles.textInput}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    );
  }
  
  return (
    <div 
      className={`${styles.textCell} ${!value ? styles.empty : ''} ${readOnly ? styles.readOnly : ''}`}
      onClick={handleClick}
      title={value || 'Click to edit'}
    >
      <span className={styles.cellText}>{value || '—'}</span>
    </div>
  );
}

// =============================================================================
// BOOLEAN CELL
// =============================================================================

interface BooleanCellProps {
  value: string | null;
  onChange: (value: string | null) => void;
  readOnly?: boolean;
}

function BooleanCell({ value, onChange, readOnly }: BooleanCellProps) {
  const isChecked = value?.toLowerCase() === 'true';
  
  const handleToggle = () => {
    if (!readOnly) {
      onChange(isChecked ? 'false' : 'true');
    }
  };
  
  return (
    <div 
      className={`${styles.booleanCell} ${readOnly ? styles.readOnly : ''}`}
      onClick={handleToggle}
    >
      <div className={`${styles.checkbox} ${isChecked ? styles.checked : ''}`}>
        {isChecked && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// LIST CELL
// =============================================================================

interface ListCellProps {
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
  readOnly?: boolean;
}

function ListCell({ value, options, onChange, readOnly }: ListCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cellRef.current && !cellRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);
  
  const handleSelect = (option: string) => {
    onChange(option);
    setIsOpen(false);
  };
  
  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setIsOpen(false);
  };
  
  return (
    <div 
      ref={cellRef}
      className={`${styles.listCell} ${readOnly ? styles.readOnly : ''}`}
    >
      <div 
        className={`${styles.listValue} ${!value ? styles.empty : ''}`}
        onClick={() => !readOnly && setIsOpen(!isOpen)}
      >
        <span>{value || '—'}</span>
        {!readOnly && (
          <svg 
            className={`${styles.chevron} ${isOpen ? styles.open : ''}`}
            width="12" 
            height="12" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </div>
      
      {isOpen && (
        <div className={styles.dropdown}>
          {value && (
            <div 
              className={styles.clearOption}
              onClick={handleClear}
            >
              Clear selection
            </div>
          )}
          {options.map((option) => (
            <div
              key={option}
              className={`${styles.option} ${option === value ? styles.selected : ''}`}
              onClick={() => handleSelect(option)}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
