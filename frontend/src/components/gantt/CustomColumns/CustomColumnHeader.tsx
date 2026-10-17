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
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin');
  
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
    if (!isAdmin) return;
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <polyline points="9 11 12 14 22 4" />
          </svg>
        );
      case 'list':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        );
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="17" y1="10" x2="3" y2="10" />
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="21" y1="14" x2="3" y2="14" />
            <line x1="17" y1="18" x2="3" y2="18" />
          </svg>
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
      title={isAdmin ? `${column.name} (double-click to edit)` : column.name}
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
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
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
                      {column.column_type === 'boolean' 
                        ? (value === 'true' ? '✓ Yes' : '✗ No')
                        : value
                      }
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      
      {isAdmin && (
        <div 
          className={styles.resizeHandle}
          onMouseDown={handleMouseDown}
          data-testid="custom-column-resize-handle"
        />
      )}
    </div>
  );
}
