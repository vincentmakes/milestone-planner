/**
 * Loading Screen
 * Displayed while checking authentication or loading data
 */

import styles from './LoadingScreen.module.css';

interface LoadingScreenProps {
  message?: string;
  /**
   * Inside a view (a lazy view's Suspense fallback): fills its slot instead
   * of the whole window, without the logo.
   */
  compact?: boolean;
}

export function LoadingScreen({ message = 'Loading...', compact = false }: LoadingScreenProps) {
  return (
    <div className={compact ? styles.compact : styles.container} role={compact ? 'status' : undefined}>
      <div className={styles.content}>
        {!compact && (
          <img
            src="/img/milestone_logo_no_text.svg"
            alt="Milestone"
            className={styles.logo}
          />
        )}
        <div className={styles.spinner} />
        <p className={styles.message}>{message}</p>
      </div>
    </div>
  );
}
