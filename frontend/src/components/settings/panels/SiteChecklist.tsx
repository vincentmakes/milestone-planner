/**
 * SiteChecklist - pick one or more sites (event targets, import targets)
 */

import type { Site } from '@/types';
import styles from './CalendarPanel.module.css';

interface SiteChecklistProps {
  sites: Site[];
  selected: number[];
  onChange: (siteIds: number[]) => void;
  /** Accessible name of the group */
  label: string;
}

export function SiteChecklist({ sites, selected, onChange, label }: SiteChecklistProps) {
  const toggle = (siteId: number, checked: boolean) => {
    onChange(checked ? [...selected, siteId] : selected.filter((id) => id !== siteId));
  };

  return (
    <div className={styles.siteChecklist} role="group" aria-label={label}>
      {sites.map((site) => (
        <label key={site.id} className={styles.siteCheck}>
          <input
            type="checkbox"
            checked={selected.includes(site.id)}
            onChange={(e) => toggle(site.id, e.target.checked)}
          />
          <span>{site.name}</span>
        </label>
      ))}
      {sites.length > 1 && (
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() =>
            onChange(selected.length === sites.length ? [] : sites.map((s) => s.id))
          }
        >
          {selected.length === sites.length ? 'Clear' : 'All sites'}
        </button>
      )}
    </div>
  );
}
