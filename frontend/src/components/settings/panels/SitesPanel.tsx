/**
 * SitesPanel (Settings hub > Sites)
 * Lists all sites and allows adding new ones; the edit button swaps the list
 * for the site form (name, location, country/region, Nager holiday refresh).
 */

import { useState, useEffect } from 'react';
import { useAppStore, selectCanManageResources } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { createSite, exportSiteToExcel } from '@/api';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import type { Site } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { SiteForm } from './SiteForm';
import { PlusIcon } from './PanelIcons';
import styles from './SitesPanel.module.css';

// Country lookup for display
const COUNTRIES: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', CH: 'Switzerland', CZ: 'Czech Republic',
  DE: 'Germany', DK: 'Denmark', ES: 'Spain', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', GR: 'Greece', HR: 'Croatia', HU: 'Hungary',
  IE: 'Ireland', IT: 'Italy', NL: 'Netherlands', NO: 'Norway', PL: 'Poland',
  PT: 'Portugal', RO: 'Romania', SE: 'Sweden', AR: 'Argentina', BR: 'Brazil',
  CA: 'Canada', CL: 'Chile', CO: 'Colombia', MX: 'Mexico', US: 'United States',
  AU: 'Australia', CN: 'China', IN: 'India', JP: 'Japan', KR: 'South Korea',
  NZ: 'New Zealand', SG: 'Singapore', AE: 'UAE', IL: 'Israel', SA: 'Saudi Arabia',
  ZA: 'South Africa',
};

function getCountryName(code: string | null | undefined): string {
  if (!code) return '';
  return COUNTRIES[code] || code;
}

export function SitesPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const settingsIntent = useUIStore((s) => s.settingsIntent);
  const clearSettingsIntent = useUIStore((s) => s.clearSettingsIntent);
  const sites = useAppStore((s) => s.sites);
  const setSites = useAppStore((s) => s.setSites);
  const canManageResources = useAppStore(selectCanManageResources);

  // Site being edited (list view when null)
  const [editingSiteId, setEditingSiteId] = useState<number | null>(null);
  const editingSite = sites.find((s) => s.id === editingSiteId) ?? null;
  
  // Opened to edit a given site (legacy 'site' modal key)
  useEffect(() => {
    if (settingsIntent?.type === 'edit') {
      setEditingSiteId(settingsIntent.id);
      clearSettingsIntent();
    }
  }, [settingsIntent, clearSettingsIntent]);

  // New site form
  const [newSiteName, setNewSiteName] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  const [exportingSiteId, setExportingSiteId] = useState<number | null>(null);
  // Unsaved input of the site form; the panel is the hub's single reporter
  const [formDirty, setFormDirty] = useState(false);
  useReportDirty(onDirtyChange, editingSite ? formDirty : newSiteName.trim() !== '');
  
  // Handle add new site
  const handleAddSite = async () => {
    if (!newSiteName.trim()) {
      setError('Please enter a site name');
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      const newSite = await createSite({ name: newSiteName.trim() });
      setSites([...sites, newSite]);
      setNewSiteName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add site');
    } finally {
      endSubmit();
    }
  };
  
  // Handle edit site - swap the list for the site form
  const handleEditSite = (site: Site) => {
    setError(null);
    setEditingSiteId(site.id);
  };

  // Handle export of a site's data as Excel
  const handleExportSite = async (site: Site) => {
    setError(null);
    setExportingSiteId(site.id);
    try {
      await exportSiteToExcel(site.id, site.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export site data');
    } finally {
      setExportingSiteId(null);
    }
  };
  
  if (editingSite) {
    return (
      <SiteForm
        site={editingSite}
        onBack={() => setEditingSiteId(null)}
        onDirtyChange={setFormDirty}
      />
    );
  }
  
  return (
    <div className={styles.container}>
      {/* Error display */}
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      {/* Site list */}
      <div className={styles.siteList}>
        {sites.length === 0 ? (
          <div className={styles.empty}>No sites configured. Add one below.</div>
        ) : (
          sites.map((site) => (
            <div 
              key={site.id} 
              className={`${styles.siteRow} ${!site.active && site.active !== undefined ? styles.inactive : ''}`}
            >
              <div className={styles.siteInfo}>
                <div className={styles.siteName}>{site.name}</div>
                <div className={styles.siteCountry}>
                  {getCountryName(site.country_code) || site.country_code || ''}
                </div>
              </div>
              <div className={styles.siteActions}>
                {!site.active && site.active !== undefined && (
                  <span className={styles.inactiveBadge}>Inactive</span>
                )}
                {canManageResources && (
                  <button
                    className={styles.editBtn}
                    onClick={() => handleExportSite(site)}
                    disabled={exportingSiteId === site.id}
                    title="Export site data as Excel"
                  >
                    {exportingSiteId === site.id ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    )}
                  </button>
                )}
                <button
                  className={styles.editBtn}
                  onClick={() => handleEditSite(site)}
                  title="Edit site"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      
      {/* Add new site section */}
      <div className={styles.addSection}>
        <div className={styles.addForm}>
          <input
            type="text"
            className={styles.input}
            placeholder="New site name"
            aria-label="New site name"
            value={newSiteName}
            onChange={(e) => setNewSiteName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddSite()}
          />
          <Button icon={<PlusIcon />} onClick={handleAddSite} disabled={isSubmitting}>
            Add site
          </Button>
        </div>
        <p className={styles.help}>
          After adding, click the edit button to set country and region codes for automatic bank holidays.
        </p>
      </div>
    </div>
  );
}
