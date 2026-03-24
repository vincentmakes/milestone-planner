/**
 * TodayLine
 * Visual indicator for the current date
 */

import { memo } from 'react';
import styles from './TodayLine.module.css';

interface TodayLineProps {
  position: number;
}

export const TodayLine = memo(function TodayLine({ position }: TodayLineProps) {
  return (
    <div className={styles.line} style={{ left: position }}>
      <div className={styles.marker} />
    </div>
  );
});
