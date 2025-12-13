/**
 * Site Management Modal
 * Lists all sites and allows adding new ones
 * Opens SiteEditModal for editing individual sites
 */

import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { createSite } from '@/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import type { Site } from '@/types';
import styles from './SiteManagementModal.module.css';

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

function getCountryName(code: string | undefined): string {
  if (!code) return '';
  return COUNTRIES[code] || code;
}

export function SiteManagementModal() {
  const { activeModal, closeModal, setEditingSite, openModal } = useUIStore();
  const sites = useAppStore((s) => s.sites);
  const setSites = useAppStore((s) => s.setSites);
  
  const isOpen = activeModal === 'manageSites' || activeModal === 'siteManagement';
  
  // New site form
  const [newSiteName, setNewSiteName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Handle add new site
  const handleAddSite = async () => {
    if (!newSiteName.trim()) {
      setError('Please enter a site name');
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const newSite = await createSite({ name: newSiteName.trim() });
      setSites([...sites, newSite]);
      setNewSiteName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add site');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Handle edit site - open the site edit modal
  const handleEditSite = (site: Site) => {
    setEditingSite(site);
    openModal('site');
  };
  
  // Handle close
  const handleClose = () => {
    setNewSiteName('');
    setError(null);
    closeModal();
  };
  
  // Footer with Close button
  const footer = (
    <div className={styles.footer}>
      <Button variant="secondary" onClick={handleClose}>
        Close
      </Button>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Site Management"
      footer={footer}
      size="md"
    >
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
            value={newSiteName}
            onChange={(e) => setNewSiteName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddSite()}
          />
          <Button 
            variant="primary" 
            onClick={handleAddSite}
            disabled={isSubmitting}
          >
            Add
          </Button>
        </div>
        <p className={styles.help}>
          After adding, click the edit button to set country and region codes for automatic bank holidays.
        </p>
      </div>
    </Modal>
  );
}
