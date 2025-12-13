import { useAppStore } from '@/stores/appStore';
import type { ViewMode } from '@/types';
import styles from './ViewModeControls.module.css';

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'week', label: 'W' },
  { value: 'month', label: 'M' },
  { value: 'quarter', label: 'Q' },
  { value: 'year', label: 'Y' },
];

export function ViewModeControls() {
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);

  return (
    <div className={styles.wrapper}>
      {VIEW_MODES.map((mode) => (
        <button
          key={mode.value}
          className={`${styles.button} ${viewMode === mode.value ? styles.active : ''}`}
          onClick={() => setViewMode(mode.value)}
          title={`${mode.value.charAt(0).toUpperCase() + mode.value.slice(1)} view`}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}
