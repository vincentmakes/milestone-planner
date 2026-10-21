import { useAppStore } from '@/stores/appStore';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { selectSite } from '@/hooks/useDataLoader';
import styles from './SiteSelector.module.css';

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
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span>{currentSite.name}</span>
        </div>
      </div>
    ) : null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.wrapper}>
        <svg
          className={styles.icon}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
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
        <svg
          className={styles.chevron}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  );
}
