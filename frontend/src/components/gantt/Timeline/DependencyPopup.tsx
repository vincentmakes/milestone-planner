/**
 * DependencyPopup
 * Popup for viewing or deleting a dependency
 * Shows on click of a dependency arrow
 */

import { memo, useCallback, useRef } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
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
  /** Whether the viewer may delete the link (the project's editors only). */
  canDelete?: boolean;
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
  canDelete = true,
}: DependencyPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Outside click, Tab out and Escape close it. The arrow click that opens the
  // popup has finished (mousedown and mouseup) before this mounts, so no delay
  // is needed to keep it from closing itself.
  const { onBlur } = useDismissableOverlay({ open: visible, onClose, wrapperRef: popupRef });

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
      role="dialog"
      aria-label={`${DEPENDENCY_TYPE_LABELS[dependencyType]} dependency`}
      onBlur={onBlur}
    >
      <div className={styles.header}>
        <span className={styles.typeLabel}>{DEPENDENCY_TYPE_LABELS[dependencyType]}</span>
        <button type="button" className={styles.closeButton} onClick={onClose} title="Close" aria-label="Close dependency details">
          <span aria-hidden="true">×</span>
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

      {canDelete && (
        <div className={styles.footer}>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete Dependency
          </button>
        </div>
      )}
    </div>
  );
});
