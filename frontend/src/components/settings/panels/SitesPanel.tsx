/**
 * SitesPanel (Settings hub > Sites)
 * Lists all sites and allows adding new ones; the edit button swaps the list
 * for the site form (name, location, country/region, Nager holiday refresh).
 * With `sites.export` alone the panel lists the visible sites with their
 * Excel export and nothing else; editing and adding need `sites.manage`.
 */

import { useState, useEffect } from 'react';
import { Notice } from '@/components/common/Notice';
import { useAppStore } from '@/stores/appStore';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { can } from '@/utils/permissions';
import { useUIStore } from '@/stores/uiStore';
import { createSite, exportSiteToExcel } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import type { Site } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { SiteForm } from './SiteForm';
import { CircleIcon, DownloadIcon, EditIcon, PlusIcon } from './PanelIcons';
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
  const allSites = useAppStore((s) => s.sites);
  const visibleSites = useVisibleSites();
  const setSites = useAppStore((s) => s.setSites);
  const canManageSites = useAppStore((s) => can(s.currentUser, 'sites.manage'));
  const canExport = useAppStore((s) => can(s.currentUser, 'sites.export'));
  const sites = canManageSites ? allSites : visibleSites;

  // Site being edited (list view when null)
  const [editingSiteId, setEditingSiteId] = useState<number | null>(null);
  const editingSite = sites.find((s) => s.id === editingSiteId) ?? null;
  
  // Opened to edit a given site (legacy 'site' modal key)
  useEffect(() => {
    if (settingsIntent?.type === 'edit') {
      if (canManageSites) setEditingSiteId(settingsIntent.id);
      clearSettingsIntent();
    }
  }, [settingsIntent, clearSettingsIntent, canManageSites]);

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
      setSites([...allSites, newSite]);
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
        <Notice tone="error" className={styles.listNotice}>{error}</Notice>
      )}
      
      {/* Site list */}
      <div className={styles.siteList}>
        {sites.length === 0 ? (
          <div className={styles.empty}>
            {canManageSites ? 'No sites configured. Add one below.' : 'No sites to export.'}
          </div>
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
                {canExport && (
                  <button
                    className={styles.editBtn}
                    onClick={() => handleExportSite(site)}
                    disabled={exportingSiteId === site.id}
                    title="Export site data as Excel"
                    aria-label={`Export ${site.name} as Excel`}
                  >
                    {exportingSiteId === site.id ? <CircleIcon /> : <DownloadIcon />}
                  </button>
                )}
                {canManageSites && (
                  <button
                    className={styles.editBtn}
                    onClick={() => handleEditSite(site)}
                    title="Edit site"
                    aria-label={`Edit ${site.name}`}
                  >
                    <EditIcon />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      
      {/* Add new site section */}
      {canManageSites && (
      <div className={styles.addSection}>
        <div className={styles.addForm}>
          <Input
            type="text"
            className={styles.addInput}
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
      )}
    </div>
  );
}
