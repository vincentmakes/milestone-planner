import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './WhatIfToggle.module.css';
import { Icon, HelpIcon, CloseIcon } from '@/components/common/Icon';

export function WhatIfToggle() {
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const whatIfPendingOperations = useWhatIfStore((s) => s.whatIfPendingOperations);
  const enterWhatIfMode = useWhatIfStore((s) => s.enterWhatIfMode);
  const exitWhatIfMode = useWhatIfStore((s) => s.exitWhatIfMode);
  const applyError = useWhatIfStore((s) => s.whatIfApplyError);
  const dismissApplyError = useWhatIfStore((s) => s.dismissApplyError);
  const [isApplying, setIsApplying] = useState(false);

  const pendingCount = whatIfPendingOperations.length;

  // Read at click time: subscribing to `projects` re-rendered the header
  // toggle on every drag/refetch.
  const handleEnter = () => {
    enterWhatIfMode(useAppStore.getState().projects);
  };

  const handleDiscard = async () => {
    const confirmed = await confirmAction(
      pendingCount > 0
        ? {
            title: 'Discard What-If changes',
            message: `Discard ${pendingCount} pending change${pendingCount !== 1 ? 's' : ''}? This cannot be undone.`,
            confirmLabel: 'Discard',
            destructive: true,
          }
        : { title: 'Exit What-If mode', message: 'Exit What If mode?', confirmLabel: 'Exit' }
    );
    if (confirmed) {
      exitWhatIfMode(false);
    }
  };

  const runApply = async () => {
    setIsApplying(true);
    try {
      await exitWhatIfMode(true);
    } finally {
      setIsApplying(false);
    }
  };

  const handleApply = async () => {
    if (pendingCount === 0) {
      exitWhatIfMode(false);
      return;
    }
    
    const confirmed = await confirmAction({
      title: 'Apply What-If changes',
      message: `Apply ${pendingCount} change${pendingCount !== 1 ? 's' : ''} to the database?`,
      confirmLabel: 'Apply',
    });
    if (confirmed) {
      await runApply();
    }
  };

  if (!whatIfMode) {
    return (
      <button
        className={styles.button}
        onClick={handleEnter}
        title="Enter What If mode to test changes without saving"
      >
        <Icon icon={HelpIcon} size={18} />
        <span className={styles.label}>What If</span>
      </button>
    );
  }

  return (
    <div className={styles.activeContainer}>
      <div className={styles.indicator}>
        <Icon icon={HelpIcon} size={16} />
        <span>What If</span>
        {pendingCount > 0 && (
          <span className={styles.pendingBadge}>{pendingCount}</span>
        )}
      </div>
      
      <button
        className={styles.discardButton}
        onClick={() => void handleDiscard()}
        disabled={isApplying}
        title="Discard all changes"
      >
        Discard
      </button>
      
      <button
        className={styles.applyButton}
        onClick={() => void handleApply()}
        disabled={isApplying}
        title={pendingCount > 0 ? `Apply ${pendingCount} change${pendingCount !== 1 ? 's' : ''}` : 'Exit What If mode'}
      >
        {isApplying ? 'Applying...' : pendingCount > 0 ? 'Apply' : 'Exit'}
      </button>

      {applyError && (
        <div className={styles.applyErrorBanner} role="alert">
          <p className={styles.applyErrorText}>
            {applyError.applied} of {applyError.total} change{applyError.total !== 1 ? 's' : ''} applied,
            then one failed: {applyError.message}
          </p>
          <p className={styles.applyErrorText}>
            {pendingCount} change{pendingCount !== 1 ? 's are' : ' is'} still queued. The view shows
            what is saved on the server.
          </p>
          <div className={styles.applyErrorActions}>
            <button
              className={styles.applyButton}
              onClick={() => void runApply()}
              disabled={isApplying || pendingCount === 0}
            >
              {isApplying ? 'Retrying...' : 'Retry'}
            </button>
            <button
              className={styles.discardButton}
              onClick={() => void handleDiscard()}
              disabled={isApplying}
            >
              Discard
            </button>
            <button
              className={styles.dismissButton}
              onClick={dismissApplyError}
              aria-label="Dismiss"
              title="Hide this message (the changes stay queued)"
            >
              <Icon icon={CloseIcon} size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
