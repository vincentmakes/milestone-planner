/**
 * StaffOverviewToggle
 * Toggle button to show/hide Staff Overview panel below Gantt chart
 * Only visible to SuperUsers and Admins
 */

import { useAppStore } from '@/stores/appStore';
import styles from './StaffOverviewToggle.module.css';

export function StaffOverviewToggle() {
  const showStaffOverview = useAppStore((s) => s.showStaffOverview);
  const toggleShowStaffOverview = useAppStore((s) => s.toggleShowStaffOverview);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentView = useAppStore((s) => s.currentView);

  // Only show for admin/superuser and only in gantt view
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'superuser')) {
    return null;
  }
  
  if (currentView !== 'gantt') {
    return null;
  }

  return (
    <button
      className={`${styles.toggle} ${showStaffOverview ? styles.active : ''}`}
      onClick={toggleShowStaffOverview}
      title={showStaffOverview ? 'Hide Staff Overview' : 'Show Staff Overview'}
    >
      <svg 
        width="18" 
        height="18" 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke="currentColor" 
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Users icon */}
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span className={styles.label}>Staff</span>
      <span className={`${styles.indicator} ${showStaffOverview ? styles.on : ''}`} />
    </button>
  );
}
