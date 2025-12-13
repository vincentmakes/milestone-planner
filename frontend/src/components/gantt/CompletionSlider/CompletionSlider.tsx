/**
 * CompletionSlider
 * A popover slider for setting completion percentage (0-100% in 5% increments)
 */

import { useState, useRef, useEffect } from 'react';
import styles from './CompletionSlider.module.css';

interface CompletionSliderProps {
  value: number | null;
  onChange: (value: number) => void;
  onClose: () => void;
  anchorEl: HTMLElement | null;
  isCalculated?: boolean;
}

export function CompletionSlider({
  value,
  onChange,
  onClose,
  anchorEl,
  isCalculated = false,
}: CompletionSliderProps) {
  const [sliderValue, setSliderValue] = useState(value ?? 0);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Position the popover near the anchor element
  useEffect(() => {
    if (!anchorEl || !popoverRef.current) return;

    const rect = anchorEl.getBoundingClientRect();
    const popover = popoverRef.current;
    
    // Position below the anchor
    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.left = `${rect.left}px`;

    // Adjust if it would go off screen
    const popoverRect = popover.getBoundingClientRect();
    if (popoverRect.right > window.innerWidth - 16) {
      popover.style.left = `${window.innerWidth - popoverRect.width - 16}px`;
    }
    if (popoverRect.bottom > window.innerHeight - 16) {
      popover.style.top = `${rect.top - popoverRect.height - 8}px`;
    }
  }, [anchorEl]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.target.value, 10);
    // Round to nearest 5
    const rounded = Math.round(newValue / 5) * 5;
    setSliderValue(rounded);
  };

  const handleApply = () => {
    onChange(sliderValue);
    onClose();
  };

  const handleClear = () => {
    onChange(-1); // -1 signals to clear the value
    onClose();
  };

  // Quick select buttons
  const quickValues = [0, 25, 50, 75, 100];

  return (
    <div ref={popoverRef} className={styles.popover}>
      <div className={styles.header}>
        <span className={styles.title}>Set Completion</span>
        {isCalculated && (
          <span className={styles.calculatedNote}>
            Currently calculated from children
          </span>
        )}
      </div>

      <div className={styles.sliderContainer}>
        {/* Large percentage display */}
        <div className={styles.valueDisplay}>{sliderValue}%</div>
        
        {/* Slider with filled track */}
        <div className={styles.sliderWrapper}>
          <div 
            className={styles.sliderTrack} 
            style={{ width: `${sliderValue}%` }}
          />
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={sliderValue}
            onChange={handleSliderChange}
            className={styles.sliderInput}
          />
        </div>
        
        {/* Tick marks */}
        <div className={styles.tickMarks}>
          <span className={styles.tick}>0</span>
          <span className={styles.tick}>25</span>
          <span className={styles.tick}>50</span>
          <span className={styles.tick}>75</span>
          <span className={styles.tick}>100</span>
        </div>
      </div>

      <div className={styles.quickSelect}>
        {quickValues.map((v) => (
          <button
            key={v}
            type="button"
            className={`${styles.quickBtn} ${sliderValue === v ? styles.active : ''}`}
            onClick={() => setSliderValue(v)}
          >
            {v}%
          </button>
        ))}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.clearBtn} onClick={handleClear}>
          Clear
        </button>
        <button type="button" className={styles.applyBtn} onClick={handleApply}>
          Apply
        </button>
      </div>
    </div>
  );
}
