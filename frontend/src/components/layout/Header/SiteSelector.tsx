import { useAppStore } from '@/stores/appStore';
import { getBankHolidays, buildHolidayDateSet } from '@/api';
import styles from './SiteSelector.module.css';

export function SiteSelector() {
  const sites = useAppStore((s) => s.sites);
  const currentSite = useAppStore((s) => s.currentSite);
  const setCurrentSite = useAppStore((s) => s.setCurrentSite);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const currentUser = useAppStore((s) => s.currentUser);

  // Filter sites based on user's assigned sites (if not admin)
  const availableSites =
    currentUser?.role === 'admin'
      ? sites
      : sites.filter((site) => currentUser?.site_ids?.includes(site.id));

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const siteId = parseInt(e.target.value, 10);
    const site = sites.find((s) => s.id === siteId);
    if (site) {
      setCurrentSite(site);
      
      // Reload bank holidays for the new site
      try {
        const holidays = await getBankHolidays(site.id);
        const holidayDates = buildHolidayDateSet(holidays);
        setBankHolidays(holidays, holidayDates);
      } catch (err) {
        console.error('[SiteSelector] Failed to load bank holidays:', err);
      }
    }
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
