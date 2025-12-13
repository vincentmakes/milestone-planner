import { useAppStore } from '@/stores/appStore';
import styles from './InstanceTitle.module.css';

export function InstanceTitle() {
  const instanceSettings = useAppStore((s) => s.instanceSettings);

  const title = instanceSettings?.instance_title || instanceSettings?.instance_name;

  // Don't render if no custom title is set
  if (!title || title === 'Milestone') {
    return null;
  }

  return (
    <div className={styles.container}>
      <span className={styles.separator}>|</span>
      <span className={styles.title}>{title}</span>
    </div>
  );
}
