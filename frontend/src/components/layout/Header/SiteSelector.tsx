import { useAppStore } from '@/stores/appStore';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { selectSite } from '@/hooks/useDataLoader';
import styles from './SiteSelector.module.css';
import { Icon, ChevronDownIcon, MapPinIcon } from '@/components/common/Icon';

export function SiteSelector() {
  const currentSite = useAppStore((s) => s.currentSite);
  // Every site with sites.view_all, otherwise the user's own
  const availableSites = useVisibleSites();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const siteId = parseInt(e.target.value, 10);
    const site = availableSites.find((s) => s.id === siteId);
    if (site) void selectSite(site);
  };

  if (availableSites.length <= 1) {
    // Don't show selector if user only has access to one site
    return currentSite ? (
      <div className={styles.container}>
        <div className={styles.singleSite}>
          <Icon icon={MapPinIcon} size={16} />
          <span>{currentSite.name}</span>
        </div>
      </div>
    ) : null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.wrapper}>
        <Icon icon={MapPinIcon} size={16} className={styles.icon} />
        <select
          className={styles.select}
          value={currentSite?.id || ''}
          onChange={handleChange}
        >
          {availableSites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        <Icon icon={ChevronDownIcon} size={12} className={styles.chevron} />
      </div>
    </div>
  );
}
