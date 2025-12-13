/**
 * Loading Screen
 * Displayed while checking authentication or loading data
 */

import styles from './LoadingScreen.module.css';

interface LoadingScreenProps {
  message?: string;
}

export function LoadingScreen({ message = 'Loading...' }: LoadingScreenProps) {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <img
          src="/img/milestone_logo_no_text.svg"
          alt="Milestone"
          className={styles.logo}
        />
        <div className={styles.spinner} />
        <p className={styles.message}>{message}</p>
      </div>
    </div>
  );
}
