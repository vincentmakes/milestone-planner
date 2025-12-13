/**
 * DependencyPopup
 * Popup for viewing or deleting a dependency
 * Shows on click of a dependency arrow
 */

import { memo, useCallback, useEffect, useRef } from 'react';
import styles from './DependencyPopup.module.css';
import type { DependencyType } from '@/types';

interface DependencyPopupProps {
  visible: boolean;
  x: number;
  y: number;
  dependencyType: DependencyType;
  fromName: string;
  toName: string;
  onClose: () => void;
  onDelete: () => void;
}

const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  FS: 'Finish-to-Start',
  SS: 'Start-to-Start',
  FF: 'Finish-to-Finish',
  SF: 'Start-to-Finish',
};

export const DependencyPopup = memo(function DependencyPopup({
  visible,
  x,
  y,
  dependencyType,
  fromName,
  toName,
  onClose,
  onDelete,
}: DependencyPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay to prevent immediate close from the click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, onClose]);

  const handleDelete = useCallback(() => {
    if (confirm(`Remove this ${dependencyType} dependency?`)) {
      onDelete();
    }
  }, [dependencyType, onDelete]);

  if (!visible) return null;

  // Adjust position to keep popup in viewport
  const adjustedX = Math.min(x, window.innerWidth - 250);
  const adjustedY = Math.min(y, window.innerHeight - 180);

  return (
    <div
      ref={popupRef}
      className={styles.popup}
      style={{
        left: adjustedX,
        top: adjustedY,
      }}
    >
      <div className={styles.header}>
        <span className={styles.typeLabel}>{DEPENDENCY_TYPE_LABELS[dependencyType]}</span>
        <button className={styles.closeButton} onClick={onClose} title="Close">
          ×
        </button>
      </div>

      <div className={styles.content}>
        <div className={styles.connection}>
          <span className={styles.fromTo}>From:</span>
          <span className={styles.name}>{fromName}</span>
        </div>
        <div className={styles.connection}>
          <span className={styles.fromTo}>To:</span>
          <span className={styles.name}>{toName}</span>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.deleteButton} onClick={handleDelete}>
          Delete Dependency
        </button>
      </div>
    </div>
  );
});
