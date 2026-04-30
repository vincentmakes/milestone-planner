import { useUndoRedo } from '@/hooks';
import styles from './UndoRedoControls.module.css';

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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
        </svg>
      </button>
      <button
        className={styles.btn}
        onClick={() => void redo()}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
        aria-label="Redo"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 15-6.7L21 13" />
        </svg>
      </button>
    </div>
  );
}
