import { useAppStore } from '@/stores/appStore';
import type { ResourceTab } from '@/types';
import styles from './ResourceTabs.module.css';

const TABS: { value: ResourceTab; label: string }[] = [
  { value: 'staff', label: 'Staff' },
  { value: 'equipment', label: 'Equipment' },
];

export function ResourceTabs() {
  const currentResourceTab = useAppStore((s) => s.currentResourceTab);
  const setCurrentResourceTab = useAppStore((s) => s.setCurrentResourceTab);

  return (
    <div className={styles.tabs}>
      {TABS.map((tab) => (
        <button
          key={tab.value}
          className={`${styles.tab} ${currentResourceTab === tab.value ? styles.active : ''}`}
          onClick={() => setCurrentResourceTab(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
