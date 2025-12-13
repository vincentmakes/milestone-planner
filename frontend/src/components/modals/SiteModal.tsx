/**
 * Site Modal
 * Modal for editing site settings (name, city, country, region, active status)
 * Bank holidays can be refreshed from here via the Nager.Date API
 * Custom holidays are managed separately in the Staff View bank holidays section
 */

import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { updateSite, refreshBankHolidays, buildHolidayDateSet } from '@/api';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import styles from './SiteModal.module.css';

// Country list organized by region
const COUNTRIES = {
  europe: [
    { code: 'AT', name: 'Austria' },
    { code: 'BE', name: 'Belgium' },
    { code: 'CH', name: 'Switzerland' },
    { code: 'CZ', name: 'Czech Republic' },
    { code: 'DE', name: 'Germany' },
    { code: 'DK', name: 'Denmark' },
    { code: 'ES', name: 'Spain' },
    { code: 'FI', name: 'Finland' },
    { code: 'FR', name: 'France' },
    { code: 'GB', name: 'United Kingdom' },
    { code: 'GR', name: 'Greece' },
    { code: 'HR', name: 'Croatia' },
    { code: 'HU', name: 'Hungary' },
    { code: 'IE', name: 'Ireland' },
    { code: 'IT', name: 'Italy' },
    { code: 'NL', name: 'Netherlands' },
    { code: 'NO', name: 'Norway' },
    { code: 'PL', name: 'Poland' },
    { code: 'PT', name: 'Portugal' },
    { code: 'RO', name: 'Romania' },
    { code: 'SE', name: 'Sweden' },
  ],
  americas: [
    { code: 'AR', name: 'Argentina' },
    { code: 'BR', name: 'Brazil' },
    { code: 'CA', name: 'Canada' },
    { code: 'CL', name: 'Chile' },
    { code: 'CO', name: 'Colombia' },
    { code: 'MX', name: 'Mexico' },
    { code: 'US', name: 'United States' },
  ],
  asiaPacific: [
    { code: 'AU', name: 'Australia' },
    { code: 'CN', name: 'China' },
    { code: 'IN', name: 'India' },
    { code: 'JP', name: 'Japan' },
    { code: 'KR', name: 'South Korea' },
    { code: 'NZ', name: 'New Zealand' },
    { code: 'SG', name: 'Singapore' },
  ],
  africaMiddleEast: [
    { code: 'AE', name: 'United Arab Emirates' },
    { code: 'IL', name: 'Israel' },
    { code: 'SA', name: 'Saudi Arabia' },
    { code: 'ZA', name: 'South Africa' },
  ],
};

export function SiteModal() {
  const { activeModal, editingSite, openModal } = useUIStore();
  const currentSite = useAppStore((s) => s.currentSite);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const setCurrentSite = useAppStore((s) => s.setCurrentSite);
  const sites = useAppStore((s) => s.sites);
  const setSites = useAppStore((s) => s.setSites);
  
  const isOpen = activeModal === 'site';
  
  // Use editingSite if available, otherwise fall back to currentSite
  const site = editingSite || currentSite;
  
  // Form state
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [regionCode, setRegionCode] = useState('');
  const [isActive, setIsActive] = useState(true);
  
  // Status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Load site data
  useEffect(() => {
    if (isOpen && site) {
      setName(site.name || '');
      setCity(site.city || '');
      setCountryCode(site.country_code || '');
      setRegionCode(site.region_code || '');
      setIsActive(site.active !== false && site.active !== 0);
      setError(null);
    }
  }, [isOpen, site]);
  
  // Get holidays count for the site being edited
  const siteHolidayCount = bankHolidays.filter((h) => 
    site && h.site_id === site.id
  ).length;
  
  // Handle save
  const handleSave = async () => {
    if (!site) return;
    if (!name.trim()) {
      setError('Site name is required');
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const updatedSite = await updateSite(site.id, {
        name: name.trim(),
        city: city.trim() || undefined,
        country_code: countryCode || undefined,
        region_code: regionCode.trim() || undefined,
        active: isActive,
      });
      
      // Update sites list
      const updatedSites = sites.map((s) => 
        s.id === site.id ? { ...s, ...updatedSite } : s
      );
      setSites(updatedSites);
      
      // Update current site if it was edited
      if (currentSite?.id === site.id) {
        setCurrentSite({ ...currentSite, ...updatedSite });
      }
      
      // Go back to site management modal
      openModal('manageSites');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save site');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Handle refresh holidays from Nager.Date API
  const handleRefreshHolidays = async () => {
    if (!site) return;
    
    if (!confirm('This will refresh bank holidays from the Nager.Date API. Continue?')) {
      return;
    }
    
    setIsRefreshing(true);
    setError(null);
    
    try {
      const holidays = await refreshBankHolidays(site.id);
      const holidayDates = buildHolidayDateSet(holidays);
      setBankHolidays(holidays, holidayDates);
      
      // Update the site's last_holiday_fetch timestamp
      const updatedSites = sites.map((s) => 
        s.id === site.id ? { ...s, last_holiday_fetch: new Date().toISOString() } : s
      );
      setSites(updatedSites);
      
      if (currentSite?.id === site.id) {
        setCurrentSite({ ...currentSite, last_holiday_fetch: new Date().toISOString() });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh holidays');
    } finally {
      setIsRefreshing(false);
    }
  };
  
  // Handle going back to site management
  const handleBack = () => {
    openModal('manageSites');
  };
  
  // Footer buttons
  const footer = (
    <div className={styles.footer}>
      <Button variant="secondary" onClick={handleBack}>
        Back
      </Button>
      <Button 
        variant="primary" 
        onClick={handleSave}
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Saving...' : 'Save Changes'}
      </Button>
    </div>
  );
  
  if (!site) {
    return null;
  }
  
  // Format last fetch date
  const lastFetchDate = site.last_holiday_fetch 
    ? new Date(site.last_holiday_fetch).toLocaleDateString()
    : 'Never';
  
  return (
    <Modal 
      isOpen={isOpen} 
      onClose={handleBack} 
      title={`Edit Site: ${site.name}`}
      size="lg"
      footer={footer}
    >
      {error && (
        <div className={styles.error}>{error}</div>
      )}
      
      {/* Site Details Section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Site Details</h3>
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Site Name</label>
          <input
            type="text"
            className={styles.input}
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="e.g., Winterthur HQ"
          />
        </div>
        
        <div className={styles.formGroup}>
          <label className={styles.label}>City</label>
          <input
            type="text"
            className={styles.input}
            value={city}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCity(e.target.value)}
            placeholder="e.g., Winterthur"
          />
        </div>
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Country</label>
            <select 
              className={styles.select}
              value={countryCode}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCountryCode(e.target.value)}
            >
              <option value="">Select country...</option>
              <optgroup label="Europe">
                {COUNTRIES.europe.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                ))}
              </optgroup>
              <optgroup label="Americas">
                {COUNTRIES.americas.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                ))}
              </optgroup>
              <optgroup label="Asia & Pacific">
                {COUNTRIES.asiaPacific.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                ))}
              </optgroup>
              <optgroup label="Africa & Middle East">
                {COUNTRIES.africaMiddleEast.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                ))}
              </optgroup>
            </select>
          </div>
          
          <div className={styles.formGroup}>
            <label className={styles.label}>Region/State Code</label>
            <input
              type="text"
              className={styles.input}
              value={regionCode}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRegionCode(e.target.value)}
              placeholder="e.g., ZH, HE, ARA"
            />
          </div>
        </div>
        
        <p className={styles.help}>
          Region codes vary by country. For Switzerland: ZH, BE, GE, etc. For Germany: BY, HE, NW, etc.
        </p>
        
        <div className={styles.checkbox}>
          <label>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIsActive(e.target.checked)}
            />
            <span>Active</span>
          </label>
        </div>
      </div>
      
      {/* Bank Holidays Status Section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Bank Holidays</h3>
        
        {!countryCode ? (
          <div className={styles.warning}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Set a country code above to enable automatic bank holiday fetching
          </div>
        ) : (
          <div className={styles.holidayStatusBox}>
            <div className={styles.holidayInfo}>
              <span className={styles.holidayCount}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {siteHolidayCount} bank holidays
              </span>
              <span className={styles.lastFetch}>
                Last updated: {lastFetchDate}
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRefreshHolidays}
              disabled={isRefreshing}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 4 }}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
          </div>
        )}
        
        <p className={styles.help}>
          Bank holidays are fetched from the Nager.Date public API. Custom holidays can be added in the Staff View under the Bank Holidays section.
        </p>
      </div>
    </Modal>
  );
}
