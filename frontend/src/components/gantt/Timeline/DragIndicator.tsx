/**
 * DragIndicator
 * Shows real-time feedback during drag and resize operations
 * - During drag: shows days lag/lead relative to dependencies
 * - During resize: shows new date and duration
 * 
 * Positioned absolutely within the timeline body, above the bar being manipulated
 */

import { memo } from 'react';
import styles from './DragIndicator.module.css';

interface DragIndicatorProps {
  visible: boolean;
  left: number;       // Position from left of timeline body
  top: number;        // Position from top of timeline body
  type: 'drag' | 'resize';
  // For drag - lag indicator
  lagDays?: number;
  // For resize - date and duration
  date?: string;
  duration?: number;
  edge?: 'left' | 'right';
}

// Format date for display
function formatDisplayDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
}

export const DragIndicator = memo(function DragIndicator({
  visible,
  left,
  top,
  type,
  lagDays,
  date,
  duration,
  edge,
}: DragIndicatorProps) {
  if (!visible) return null;

  if (type === 'drag' && lagDays !== undefined) {
    // Lag indicator during drag
    const isPositive = lagDays >= 0;
    const lagText = isPositive ? `+${lagDays}d` : `${lagDays}d`;
    
    return (
      <div 
        className={`${styles.lagIndicator} ${isPositive ? styles.positive : styles.negative}`}
        style={{ left, top }}
      >
        {lagText}
      </div>
    );
  }

  if (type === 'resize' && date) {
    // Resize indicator - transform based on edge
    const transform = edge === 'left' ? 'translateX(-100%)' : 'translateX(0)';
    
    return (
      <div 
        className={styles.resizeIndicator}
        style={{ left, top, transform }}
      >
        <span className={styles.duration}>{duration}d</span>
        <span className={styles.date}>{formatDisplayDate(date)}</span>
      </div>
    );
  }

  return null;
});
