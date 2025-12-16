/**
 * EquipmentOverviewToggle
 * Toggle button to show/hide Equipment Overview panel below Gantt chart
 * Only visible to SuperUsers and Admins
 */

import { useAppStore } from '@/stores/appStore';
import styles from './EquipmentOverviewToggle.module.css';

export function EquipmentOverviewToggle() {
  const showEquipmentOverview = useAppStore((s) => s.showEquipmentOverview);
  const toggleShowEquipmentOverview = useAppStore((s) => s.toggleShowEquipmentOverview);
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
      className={`${styles.toggle} ${showEquipmentOverview ? styles.active : ''}`}
      onClick={toggleShowEquipmentOverview}
      title={showEquipmentOverview ? 'Hide Equipment Overview' : 'Show Equipment Overview'}
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
        {/* Wrench/Tool icon for equipment */}
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span className={styles.label}>Equipment</span>
      <span className={`${styles.indicator} ${showEquipmentOverview ? styles.on : ''}`} />
    </button>
  );
}
