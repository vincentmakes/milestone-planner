/**
 * The allocation control, shared by the Gantt's assignment dialog and the
 * Kanban card so a booking is set the same way from either view.
 *
 * Two shapes of the same control: the full form field (label, tick marks,
 * over-capacity warning) and a `compact` variant for a list row.
 *
 * Dragging a range input fires a change per step, which is fine for a form
 * that saves on submit and ruinous for a caller that persists each change.
 * Hence `onChange` (live, every step) and `onCommit` (once, on release) —
 * a caller that persists should use `onCommit` alone.
 */

import { useId, useRef, useState } from 'react';
import {
  ALLOCATION_STEP,
  MAX_ALLOCATION,
  MIN_ALLOCATION,
  clampAllocation,
  snapToStep,
} from './allocation';
import styles from './AllocationSlider.module.css';

interface AllocationSliderProps {
  value: number;
  /** Fires on every step while dragging. For controlled form fields. */
  onChange?: (value: number) => void;
  /**
   * Fires once when the drag ends. Awaited, so the displayed value holds the
   * user's choice until the caller has persisted and refreshed it — otherwise
   * the thumb snaps back to the old number and jumps again a moment later.
   */
  onCommit?: (value: number) => void | Promise<void>;
  /** Undefined means unknown — no warning rather than a wrong one. */
  maxCapacity?: number;
  disabled?: boolean;
  /** List-row variant: no tick marks, no warning box, value shown inline. */
  compact?: boolean;
  label?: string;
  'aria-label'?: string;
}

export function AllocationSlider({
  value,
  onChange,
  onCommit,
  maxCapacity,
  disabled,
  compact = false,
  label = 'Allocation',
  'aria-label': ariaLabel,
}: AllocationSliderProps) {
  const inputId = useId();
  // Held only while dragging, so an external change to `value` (picking a
  // different person auto-sets their capacity) is never masked afterwards.
  const [draft, setDraft] = useState<number | null>(null);
  // A caller that disables the slider while saving makes it blur, which would
  // otherwise re-enter commit() and write the same value twice.
  const committing = useRef(false);

  const shown = clampAllocation(draft ?? value);
  const over = maxCapacity !== undefined && shown > maxCapacity;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = clampAllocation(snapToStep(Number(e.target.value)));
    setDraft(next);
    onChange?.(next);
  };

  const commit = async () => {
    if (draft === null || committing.current) return;
    const next = draft;
    if (next === value || !onCommit) {
      setDraft(null);
      return;
    }
    committing.current = true;
    try {
      await onCommit(next);
    } finally {
      committing.current = false;
      setDraft(null);
    }
  };

  const slider = (
    <input
      id={inputId}
      type="range"
      className={`${styles.slider} ${over ? styles.sliderOverallocated : ''}`}
      min={MIN_ALLOCATION}
      max={MAX_ALLOCATION}
      step={ALLOCATION_STEP}
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-valuetext={`${shown}%`}
      title={over ? `Above this person's maximum capacity of ${maxCapacity}%` : undefined}
      onChange={handleChange}
      // Mouse, touch and keyboard all end a change differently; blur catches
      // the case where focus leaves mid-interaction.
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  );

  if (compact) {
    return (
      <div className={styles.compact}>
        {slider}
        <span className={`${styles.compactValue} ${over ? styles.compactValueOver : ''}`}>
          {shown}%
        </span>
      </div>
    );
  }

  return (
    <>
      <label className={styles.label} htmlFor={inputId}>
        {label}: {shown}%
        {maxCapacity !== undefined && maxCapacity < 100 && (
          <span className={styles.capacityHint}> (Max capacity: {maxCapacity}%)</span>
        )}
      </label>
      <div className={styles.sliderContainer}>
        {slider}
        <div className={styles.sliderLabels}>
          <span>{MIN_ALLOCATION}%</span>
          {/* Only when it will not collide with the fixed 5/50/100 marks. */}
          {maxCapacity !== undefined && maxCapacity > 25 && maxCapacity < 75 && (
            <span className={styles.maxCapacityMarker}>{maxCapacity}%</span>
          )}
          <span>50%</span>
          <span>{MAX_ALLOCATION}%</span>
        </div>
      </div>
      {over && (
        <div className={styles.overallocationWarning}>
          ⚠️ Allocation exceeds staff&apos;s max capacity of {maxCapacity}%
        </div>
      )}
    </>
  );
}
