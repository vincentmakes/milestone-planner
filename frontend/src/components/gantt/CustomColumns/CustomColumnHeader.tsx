/**
 * CustomColumnHeader Component
 * Displays the column header with resize handle, filter dropdown, and context menu
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { updateCustomColumn } from '@/api';
import { useCustomColumnStore } from '@/stores/customColumnStore';
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
  const [isResizing, setIsResizing] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  
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
  
  // Close filter when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setShowFilter(false);
      }
    };
    
    if (showFilter) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showFilter]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startWidth = column.width;
    
    setIsResizing(true);
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(60, Math.min(400, startWidth + delta));
      onWidthChange(column.id, newWidth);
    };
    
    const handleMouseUp = async () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      // Persist the new width
      try {
        await updateCustomColumn(column.id, { width: column.width });
      } catch (err) {
        console.error('[CustomColumnHeader] Failed to save width:', err);
      }
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [column.id, column.width, onWidthChange]);
  
  const handleDoubleClick = () => {
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
      title={`${column.name} (double-click to edit)`}
    >
      <div className={styles.content}>
        <span className={styles.icon}>{getTypeIcon()}</span>
        <span className={styles.name}>{column.name}</span>
      </div>
      
      {/* Filter button */}
      <button
        className={`${styles.filterBtn} ${hasActiveFilter ? styles.active : ''}`}
        onClick={handleFilterClick}
        title="Filter column"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      </button>
      
      {/* Filter dropdown */}
      {showFilter && (
        <div className={styles.filterDropdown}>
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
      
      <div 
        className={styles.resizeHandle}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
