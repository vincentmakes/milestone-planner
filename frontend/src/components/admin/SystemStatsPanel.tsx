/**
 * SystemStatsPanel
 * System statistics display
 */

import { useAdminStore } from '@/stores/adminStore';
import styles from './SystemStatsPanel.module.css';

interface SystemStatsPanelProps {
  onRefresh: () => void;
}

export function SystemStatsPanel({ onRefresh }: SystemStatsPanelProps) {
  const systemStats = useAdminStore((s) => s.systemStats);

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  if (!systemStats) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading statistics...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2>System Statistics</h2>
        <button className={styles.refreshBtn} onClick={onRefresh}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Stats Grid */}
      <div className={styles.grid}>
        {/* Tenants Section */}
        <div className={styles.section}>
          <h3>Tenants</h3>
          <div className={styles.statsRow}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Total</span>
              <span className={styles.statValue}>{systemStats.tenants.total}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Active</span>
              <span className={`${styles.statValue} ${styles.success}`}>{systemStats.tenants.active}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Pending</span>
              <span className={`${styles.statValue} ${styles.warning}`}>{systemStats.tenants.pending}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Suspended</span>
              <span className={`${styles.statValue} ${styles.danger}`}>{systemStats.tenants.suspended}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Archived</span>
              <span className={styles.statValue}>{systemStats.tenants.archived}</span>
            </div>
          </div>
        </div>

        {/* Connections Section */}
        <div className={styles.section}>
          <h3>Database Connections</h3>
          <div className={styles.statsRow}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Active Pools</span>
              <span className={styles.statValue}>{systemStats.connections.active_pools}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Total Connections</span>
              <span className={styles.statValue}>{systemStats.connections.total_connections}</span>
            </div>
          </div>
        </div>

        {/* System Section */}
        <div className={styles.section}>
          <h3>Server</h3>
          <div className={styles.statsRow}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Uptime</span>
              <span className={styles.statValue}>{formatUptime(systemStats.system.uptime)}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Memory</span>
              <span className={styles.statValue}>{Math.round(systemStats.system.memory_mb)} MB</span>
            </div>
          </div>
          <div className={styles.info}>
            <span className={styles.infoLabel}>Python Version:</span>
            <code className={styles.infoValue}>{systemStats.system.python_version.split(' ')[0]}</code>
          </div>
        </div>
      </div>
    </div>
  );
}
