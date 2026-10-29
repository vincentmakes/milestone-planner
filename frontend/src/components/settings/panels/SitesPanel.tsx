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
import { createSite, deleteSite, exportSiteToExcel } from '@/api';
import { useDataLoader } from '@/hooks/useDataLoader';
import { confirmAction } from '@/utils/confirmDialog';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import type { Site } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { SiteForm } from './SiteForm';
import { Icon, CircleIcon, DownloadIcon, EditIcon, PlusIcon, TrashIcon } from '@/components/common/Icon';
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

/** What deleting a site removes, in the typed-name confirmation. */
export const SITE_DELETE_MESSAGE =
  'Its projects with their phases and bookings, its bank holidays, closures and events, its teams and ' +
  'memberships, equipment linked only to this site, and tags or field items limited to it are deleted. ' +
  'People assigned only to this site keep their account but lose access to its data. This cannot be undone.';

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
  const [deletingSiteId, setDeletingSiteId] = useState<number | null>(null);
  const { loadAllData } = useDataLoader();
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
  
  // Delete a site behind a typed confirmation (its name). The server refuses
  // the last active site (409), shown in place. Afterwards everything reloads:
  // loadAllData() falls back to the first visible site when the current one
  // is gone.
  const handleDeleteSite = async (site: Site) => {
    setError(null);
    const confirmed = await confirmAction({
      title: `Delete ${site.name}?`,
      message: SITE_DELETE_MESSAGE,
      confirmLabel: 'Delete site',
      destructive: true,
      confirmWord: site.name,
    });
    // Confirm first, then claim the panel's one write guard.
    if (!confirmed || !beginSubmit()) return;
    setDeletingSiteId(site.id);
    try {
      await deleteSite(site.id);
      await loadAllData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete site');
    } finally {
      setDeletingSiteId(null);
      endSubmit();
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
                    {exportingSiteId === site.id ? <Icon icon={CircleIcon} size={14} /> : <Icon icon={DownloadIcon} size={14} />}
                  </button>
                )}
                {canManageSites && (
                  <button
                    className={styles.editBtn}
                    onClick={() => handleEditSite(site)}
                    title="Edit site"
                    aria-label={`Edit ${site.name}`}
                  >
                    <Icon icon={EditIcon} size={15} />
                  </button>
                )}
                {canManageSites && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.deleteBtn}
                    icon={<Icon icon={TrashIcon} size={15} />}
                    onClick={() => void handleDeleteSite(site)}
                    loading={deletingSiteId === site.id}
                    disabled={deletingSiteId !== null}
                    title="Delete site"
                    aria-label={`Delete ${site.name}`}
                  />
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
          <Button icon={<Icon icon={PlusIcon} />} onClick={handleAddSite} disabled={isSubmitting}>
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
