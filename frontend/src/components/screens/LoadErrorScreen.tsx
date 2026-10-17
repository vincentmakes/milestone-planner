/**
 * Load Error Screen
 * Shown when the initial data load after login fails (e.g. GET /api/sites
 * answered 500), instead of an empty workspace that looks like "no data".
 */

import styles from './LoadingScreen.module.css';

interface LoadErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export function LoadErrorScreen({ message, onRetry }: LoadErrorScreenProps) {
  return (
    <div className={styles.container}>
      <div className={styles.content} role="alert">
        <img
          src="/img/milestone_logo_no_text.svg"
          alt="Milestone"
          className={styles.logo}
        />
        <p className={styles.message}>The workspace could not be loaded.</p>
        <p className={styles.message}>{message}</p>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            background: 'var(--accent-blue)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 'var(--font-size-md)',
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
