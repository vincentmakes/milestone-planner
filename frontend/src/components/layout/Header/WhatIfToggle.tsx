import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import styles from './WhatIfToggle.module.css';

export function WhatIfToggle() {
  const whatIfMode = useAppStore((s) => s.whatIfMode);
  const whatIfPendingOperations = useAppStore((s) => s.whatIfPendingOperations);
  const enterWhatIfMode = useAppStore((s) => s.enterWhatIfMode);
  const exitWhatIfMode = useAppStore((s) => s.exitWhatIfMode);
  const [isApplying, setIsApplying] = useState(false);

  const pendingCount = whatIfPendingOperations.length;

  const handleEnter = () => {
    enterWhatIfMode();
  };

  const handleDiscard = () => {
    const confirmed = window.confirm(
      pendingCount > 0
        ? `Discard ${pendingCount} pending change${pendingCount !== 1 ? 's' : ''}? This cannot be undone.`
        : 'Exit What If mode?'
    );
    if (confirmed) {
      exitWhatIfMode(false);
    }
  };

  const handleApply = async () => {
    if (pendingCount === 0) {
      exitWhatIfMode(false);
      return;
    }
    
    const confirmed = window.confirm(
      `Apply ${pendingCount} change${pendingCount !== 1 ? 's' : ''} to the database?`
    );
    if (confirmed) {
      setIsApplying(true);
      try {
        await exitWhatIfMode(true);
      } finally {
        setIsApplying(false);
      }
    }
  };

  if (!whatIfMode) {
    return (
      <button
        className={styles.button}
        onClick={handleEnter}
        title="Enter What If mode to test changes without saving"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className={styles.label}>What If</span>
      </button>
    );
  }

  return (
    <div className={styles.activeContainer}>
      <div className={styles.indicator}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>What If</span>
        {pendingCount > 0 && (
          <span className={styles.pendingBadge}>{pendingCount}</span>
        )}
      </div>
      
      <button
        className={styles.discardButton}
        onClick={handleDiscard}
        disabled={isApplying}
        title="Discard all changes"
      >
        Discard
      </button>
      
      <button
        className={styles.applyButton}
        onClick={handleApply}
        disabled={isApplying}
        title={pendingCount > 0 ? `Apply ${pendingCount} change${pendingCount !== 1 ? 's' : ''}` : 'Exit What If mode'}
      >
        {isApplying ? 'Applying...' : pendingCount > 0 ? 'Apply' : 'Exit'}
      </button>
    </div>
  );
}
