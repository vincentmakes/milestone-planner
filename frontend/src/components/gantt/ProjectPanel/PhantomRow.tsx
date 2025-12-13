/**
 * PhantomRow
 * 
 * Row in the project panel during phantom sibling mode.
 * Shows "New Phase/Subphase" label with cancel button.
 */

import { useUIStore } from '@/stores/uiStore';
import styles from './PhantomRow.module.css';

interface PhantomRowProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function PhantomRow({ onComplete, onCancel }: PhantomRowProps) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);

  if (!phantomSiblingMode) return null;

  const { type, phantomColor, dependencyType } = phantomSiblingMode;
  const depLabel = dependencyType === 'SS' ? 'Start-to-Start' : 'Finish-to-Start';

  return (
    <div 
      className={styles.phantomRow}
      onClick={(e) => {
        // Clicking anywhere on the row (except cancel) completes the phantom
        if (!(e.target as HTMLElement).closest(`.${styles.cancelBtn}`)) {
          e.stopPropagation();
          onComplete();
        }
      }}
    >
      <span
        className={styles.typeBadge}
        style={{
          backgroundColor: `${phantomColor}40`,
          color: phantomColor,
        }}
      >
        New {type === 'phase' ? 'Phase' : 'Subphase'}
      </span>
      <span className={styles.instructions}>
        Move & click to place... ({depLabel})
      </span>
      <button
        className={styles.cancelBtn}
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        title="Cancel (Esc)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export default PhantomRow;
