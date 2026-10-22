/**
 * CustomColumnHeader Component
 * Displays the column header with resize handle, filter dropdown, and context menu
 *
 * Column *definitions* (name, type, width) are admin-only on the backend
 * (`require_admin`), so the double-click editor and the resize handle are only
 * offered to admins. Filtering is a local view setting and stays open to all.
 */

import { useRef, useState, useCallback, useMemo } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { updateCustomColumn } from '@/api';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useAppStore } from '@/stores/appStore';
import type { CustomColumn } from '@/types';
import styles from './CustomColumnHeader.module.css';
import { can } from '@/utils/permissions';
import { Icon, FilterIcon, NotesIcon, ChevronDownIcon, CheckBoxIcon, CheckIcon, CloseIcon } from '@/components/common/Icon';

interface CustomColumnHeaderProps {
  column: CustomColumn;
  onEdit: (column: CustomColumn) => void;
  onWidthChange: (columnId: number, width: number) => void;
}

export function CustomColumnHeader({ 
  column, 
  onEdit,
  onWidthChange 
}: CustomColumnHeaderProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  // Global gate: custom-column definitions are admin-only
  // Column definitions: custom_columns.manage
  const canManageColumns = useAppStore((s) => can(s.currentUser, 'custom_columns.manage'));
  
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  const setCustomColumnFilter = useCustomColumnStore((s) => s.setCustomColumnFilter);
  const clearCustomColumnFilter = useCustomColumnStore((s) => s.clearCustomColumnFilter);
  
  const activeFilter = customColumnFilters[column.id] || [];
  const hasActiveFilter = activeFilter.length > 0;
  
  // Get unique values for this column from all entities
  const uniqueValues = useMemo(() => {
    const values = new Set<string>();
    Object.entries(customColumnValues).forEach(([key, value]) => {
      if (key.startsWith(`${column.id}-`) && value) {
        values.add(value);
      }
    });
    return Array.from(values).sort();
  }, [column.id, customColumnValues]);
  
  // The header wraps the filter button and its panel, so it is the dismiss boundary
  const { onBlur: onFilterBlur } = useDismissableOverlay({
    open: showFilter,
    onClose: () => setShowFilter(false),
    wrapperRef: headerRef,
    triggerRef: filterTriggerRef,
  });
  
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startWidth = column.width;
    // The latest width: `column.width` in this closure is the pre-resize value
    let latestWidth = startWidth;
    
    setIsResizing(true);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(60, Math.min(400, startWidth + delta));
      latestWidth = newWidth;
      onWidthChange(column.id, newWidth);
    };
    
    const handleMouseUp = async () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      // Persist the new width
      if (latestWidth === startWidth) return;
      try {
        await updateCustomColumn(column.id, { width: latestWidth });
      } catch (err) {
        console.error('[CustomColumnHeader] Failed to save width:', err);
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [column.id, column.width, onWidthChange]);
  
  const handleDoubleClick = () => {
    if (!canManageColumns) return;
    onEdit(column);
  };
  
  const handleFilterClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowFilter(!showFilter);
  };
  
  const handleFilterToggle = (value: string) => {
    const newFilter = activeFilter.includes(value)
      ? activeFilter.filter(v => v !== value)
      : [...activeFilter, value];
    
    if (newFilter.length === 0) {
      clearCustomColumnFilter(column.id);
    } else {
      setCustomColumnFilter(column.id, newFilter);
    }
  };
  
  const handleClearFilter = () => {
    clearCustomColumnFilter(column.id);
    setShowFilter(false);
  };
  
  const handleSelectAll = () => {
    setCustomColumnFilter(column.id, uniqueValues);
  };
  
  // Get icon based on column type
  const getTypeIcon = () => {
    switch (column.column_type) {
      case 'boolean':
        return (
          <Icon icon={CheckBoxIcon} size={12} />
        );
      case 'list':
        return (
          <Icon icon={ChevronDownIcon} size={12} />
        );
      default:
        return (
          <Icon icon={NotesIcon} size={12} />
        );
    }
  };
  
  return (
    <div 
      ref={headerRef}
      className={`${styles.header} ${isResizing ? styles.resizing : ''} ${hasActiveFilter ? styles.filtered : ''}`}
      style={{ width: column.width }}
      onDoubleClick={handleDoubleClick}
      onBlur={onFilterBlur}
      title={canManageColumns ? `${column.name} (double-click to edit)` : column.name}
    >
      <div className={styles.content}>
        <span className={styles.icon}>{getTypeIcon()}</span>
        <span className={styles.name}>{column.name}</span>
      </div>
      
      {/* Filter button */}
      <button
        ref={filterTriggerRef}
        type="button"
        className={`${styles.filterBtn} ${hasActiveFilter ? styles.active : ''}`}
        onClick={handleFilterClick}
        title="Filter column"
        aria-label={`Filter ${column.name}`}
        aria-expanded={showFilter}
        aria-haspopup="dialog"
      >
        <Icon icon={FilterIcon} size={12} />
      </button>
      
      {/* Filter dropdown */}
      {showFilter && (
        <div className={styles.filterDropdown} role="dialog" aria-label={`Filter ${column.name}`}>
          <div className={styles.filterHeader}>
            <span>Filter by value</span>
            {hasActiveFilter && (
              <button className={styles.clearFilterBtn} onClick={handleClearFilter}>
                Clear
              </button>
            )}
          </div>
          
          {uniqueValues.length === 0 ? (
            <div className={styles.filterEmpty}>No values</div>
          ) : (
            <>
              <div className={styles.filterActions}>
                <button onClick={handleSelectAll}>Select All</button>
                <button onClick={handleClearFilter}>Clear All</button>
              </div>
              <div className={styles.filterOptions}>
                {/* Empty/null option */}
                <label className={styles.filterOption}>
                  <input
                    type="checkbox"
                    checked={activeFilter.includes('__empty__')}
                    onChange={() => handleFilterToggle('__empty__')}
                  />
                  <span className={styles.filterValueEmpty}>(Empty)</span>
                </label>
                {uniqueValues.map(value => (
                  <label key={value} className={styles.filterOption}>
                    <input
                      type="checkbox"
                      checked={activeFilter.includes(value)}
                      onChange={() => handleFilterToggle(value)}
                    />
                    <span className={styles.filterValue}>
                      {column.column_type === 'boolean' ? (
                        <span className={styles.booleanValue}>
                          <Icon icon={value === 'true' ? CheckIcon : CloseIcon} size={12} />
                          {value === 'true' ? 'Yes' : 'No'}
                        </span>
                      ) : (
                        value
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      
      {canManageColumns && (
        <div 
          className={styles.resizeHandle}
          onMouseDown={handleMouseDown}
          data-testid="custom-column-resize-handle"
        />
      )}
    </div>
  );
}
