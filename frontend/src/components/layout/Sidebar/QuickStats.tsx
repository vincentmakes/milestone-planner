import { useAppStore } from '@/stores/appStore';
import styles from './QuickStats.module.css';

export function QuickStats() {
  const projects = useAppStore((s) => s.projects);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentSite = useAppStore((s) => s.currentSite);

  // Filter by current site
  const siteProjects = currentSite
    ? projects.filter((p) => p.site_id === currentSite.id && !p.archived)
    : projects.filter((p) => !p.archived);

  const siteStaff = currentSite
    ? staff.filter((s) => s.site_id === currentSite.id && s.active)
    : staff.filter((s) => s.active);

  const siteEquipment = currentSite
    ? equipment.filter((e) => e.site_id === currentSite.id && e.active)
    : equipment.filter((e) => e.active);

  const confirmedProjects = siteProjects.filter((p) => p.confirmed).length;
  const unconfirmedProjects = siteProjects.filter((p) => !p.confirmed).length;

  return (
    <div className={styles.stats}>
      <div className={styles.stat}>
        <span className={styles.value}>{siteProjects.length}</span>
        <span className={styles.label}>Projects</span>
        <span className={styles.detail}>
          {confirmedProjects} confirmed, {unconfirmedProjects} pending
        </span>
      </div>
      <div className={styles.stat}>
        <span className={styles.value}>{siteStaff.length}</span>
        <span className={styles.label}>Staff</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.value}>{siteEquipment.length}</span>
        <span className={styles.label}>Equipment</span>
      </div>
    </div>
  );
}
