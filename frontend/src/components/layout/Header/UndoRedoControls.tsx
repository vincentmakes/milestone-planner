import { useUndoRedo } from '@/hooks';
import styles from './UndoRedoControls.module.css';
import { Icon, RedoIcon, UndoIcon } from '@/components/common/Icon';

export function UndoRedoControls() {
  const { canUndo, canRedo, undo, redo } = useUndoRedo();

  return (
    <div className={styles.controls}>
      <button
        className={styles.btn}
        onClick={() => void undo()}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <Icon icon={UndoIcon} size={14} />
      </button>
      <button
        className={styles.btn}
        onClick={() => void redo()}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
        aria-label="Redo"
      >
        <Icon icon={RedoIcon} size={14} />
      </button>
    </div>
  );
}
