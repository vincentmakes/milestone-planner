/**
 * PhantomRow
 * 
 * Row in the project panel during phantom sibling mode.
 * Shows "New Phase/Subphase" label with cancel button.
 */

import { useUIStore } from '@/stores/uiStore';
import styles from './PhantomRow.module.css';
import { Icon, CloseIcon } from '@/components/common/Icon';

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
        <Icon icon={CloseIcon} size={12} />
      </button>
    </div>
  );
}

export default PhantomRow;
