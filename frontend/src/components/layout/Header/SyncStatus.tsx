/**
 * SyncStatus
 * Small header badge shown while live sync is down (browser offline, or the
 * WebSocket dropped and has not reconnected yet). Edits still save over HTTP;
 * what pauses is seeing other people's changes as they happen.
 */
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import styles from './SyncStatus.module.css';

export function SyncStatus() {
  const { offline } = useWebSocketContext();
  if (!offline) return null;
  return (
    <span
      role="status"
      className={styles.offline}
      title="Live updates are paused: changes made by others will appear once the connection is back."
    >
      <span className={styles.dot} aria-hidden="true" />
      Offline
    </span>
  );
}
