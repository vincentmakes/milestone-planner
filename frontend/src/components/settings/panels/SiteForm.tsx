/**
 * SiteForm (Settings hub > Sites > edit)
 * Edits site settings (name, city, country, region, active status).
 * Bank holidays can be refreshed from here via the Nager holiday API, unless
 * the admin turned the import off (Settings → Features & defaults); individual
 * holidays are managed in the Bank holidays section.
 */

import { useState, useEffect } from 'react';
import { Notice } from '@/components/common/Notice';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { updateSite, getBankHolidays, refreshBankHolidays, buildHolidayDateSet } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import type { SelectOption } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useReportDirty } from '../useReportDirty';
import { BackIcon, RefreshIcon } from './PanelIcons';
import type { Site } from '@/types';
import { confirmAction } from '@/utils/confirmDialog';
import { isSettingOn } from '@/utils/instanceSettings';
import styles from './SiteForm.module.css';

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

const toOptions = (countries: { code: string; name: string }[]): SelectOption[] =>
  countries.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }));

/** '' (no country) stays a selectable choice: picking it clears the site's country */
const NO_COUNTRY_OPTION: SelectOption[] = [{ value: '', label: 'Select country...' }];

/** The regions as option groups, in the order the list has always had */
const COUNTRY_GROUPS = [
  { label: 'Europe', options: toOptions(COUNTRIES.europe) },
  { label: 'Americas', options: toOptions(COUNTRIES.americas) },
  { label: 'Asia & Pacific', options: toOptions(COUNTRIES.asiaPacific) },
  { label: 'Africa & Middle East', options: toOptions(COUNTRIES.africaMiddleEast) },
];

interface SiteFormProps {
  site: Site;
  /** Back to the site list */
  onBack: () => void;
  /** Unsaved input in the form (reported to the Settings hub by the panel) */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The PUT /sites/{id} body. An explicit `null` clears City / Country / Region
 * (an omitted field means "unchanged" to the backend), which the `Site` model
 * type (optional strings) cannot express.
 */
interface SiteUpdatePayload {
  name: string;
  city: string | null;
  country_code: string | null;
  region_code: string | null;
  active: boolean;
}

export function SiteForm({ site, onBack, onDirtyChange }: SiteFormProps) {
  const openSettings = useUIStore((s) => s.openSettings);
  const currentSite = useAppStore((s) => s.currentSite);
  const setBankHolidays = useAppStore((s) => s.setBankHolidays);
  const setCurrentSite = useAppStore((s) => s.setCurrentSite);
  const sites = useAppStore((s) => s.sites);
  const setSites = useAppStore((s) => s.setSites);
  const nagerOn = useAppStore((s) => isSettingOn(s.instanceSettings, 'nager_enabled'));
  
  // Form state
  const [name, setName] = useState(site.name || '');
  const [city, setCity] = useState(site.city || '');
  const [countryCode, setCountryCode] = useState(site.country_code || '');
  const [regionCode, setRegionCode] = useState(site.region_code || '');
  const [isActive, setIsActive] = useState(site.active !== false && site.active !== 0);
  
  // Status
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteHolidayCount, setSiteHolidayCount] = useState<number | null>(null);
  
  useReportDirty(
    onDirtyChange,
    name !== (site.name || '') ||
      city !== (site.city || '') ||
      countryCode !== (site.country_code || '') ||
      regionCode !== (site.region_code || '') ||
      isActive !== (site.active !== false && site.active !== 0)
  );
  
  // Count the holidays of the site being edited (not necessarily the current site)
  useEffect(() => {
    let cancelled = false;
    getBankHolidays(site.id)
      .then((holidays) => {
        if (!cancelled) setSiteHolidayCount(holidays.length);
      })
      .catch(() => {
        if (!cancelled) setSiteHolidayCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [site.id]);
  
  // Handle save
  const handleSave = async () => {
    if (!name.trim()) {
      setError('Site name is required');
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      // Cleared fields are sent as null so the backend clears them
      const payload: SiteUpdatePayload = {
        name: name.trim(),
        city: city.trim() || null,
        country_code: countryCode || null,
        region_code: regionCode.trim() || null,
        active: isActive,
      };
      const updatedSite = await updateSite(site.id, payload);
      
      // Update sites list
      const updatedSites = sites.map((s) => 
        s.id === site.id ? { ...s, ...updatedSite } : s
      );
      setSites(updatedSites);
      
      // Update current site if it was edited
      if (currentSite?.id === site.id) {
        setCurrentSite({ ...currentSite, ...updatedSite });
      }
      
      // Back to the site list
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save site');
    } finally {
      endSubmit();
    }
  };
  
  // Handle refresh holidays from the Nager holiday API
  const handleRefreshHolidays = async () => {
    const confirmed = await confirmAction({
      title: 'Refresh holidays',
      message: 'This will refresh bank holidays from the Nager holiday API. Continue?',
      confirmLabel: 'Refresh',
    });
    if (!confirmed) return;
    
    setIsRefreshing(true);
    setError(null);
    
    try {
      const holidays = await refreshBankHolidays(site.id);
      setSiteHolidayCount(holidays.length);
      // The store holds the current site's holidays only
      if (currentSite?.id === site.id) {
        setBankHolidays(holidays, buildHolidayDateSet(holidays));
      }
      
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
  
  // Format last fetch date
  const lastFetchDate = site.last_holiday_fetch 
    ? new Date(site.last_holiday_fetch).toLocaleDateString()
    : 'Never';
  
  return (
    <div className={styles.container}>
      <Button type="button" variant="ghost" icon={<BackIcon />} className={styles.backLink} onClick={onBack}>
        All sites
      </Button>
      <h4 className={styles.formTitle}>Edit site: {site.name}</h4>
      
      {error && (
        <Notice tone="error" className={styles.formNotice}>{error}</Notice>
      )}
      
      {/* Site Details Section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Site Details</h3>
        
        <Input
          label="Site Name"
          type="text"
          className={styles.formGroup}
          fullWidth
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="e.g., Winterthur HQ"
        />
        
        <Input
          label="City"
          type="text"
          className={styles.formGroup}
          fullWidth
          value={city}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCity(e.target.value)}
          placeholder="e.g., Winterthur"
        />
        
        <div className={styles.formRow}>
          <Select
            label="Country"
            className={styles.formGroup}
            fullWidth
            options={NO_COUNTRY_OPTION}
            groups={COUNTRY_GROUPS}
            value={countryCode}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCountryCode(e.target.value)}
          />
          
          <Input
            label="Region/State Code"
            type="text"
            className={styles.formGroup}
            fullWidth
            value={regionCode}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRegionCode(e.target.value)}
            placeholder="e.g., ZH, HE, ARA"
          />
        </div>
        
        <p className={styles.help}>
          Region codes vary by country. For Switzerland: ZH, BE, GE, etc. For Germany: BY, HE, NW, etc.
        </p>
        
        <div className={styles.checkbox}>
          <ToggleSwitch checked={isActive} onChange={setIsActive} label="Active" />
        </div>
      </div>
      
      {/* Bank Holidays Status Section */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Bank Holidays</h3>
        
        {nagerOn && !countryCode ? (
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
                {siteHolidayCount === null ? 'Bank holidays' : `${siteHolidayCount} bank holidays`}
              </span>
              {nagerOn && (
                <span className={styles.lastFetch}>
                  Last updated: {lastFetchDate}
                </span>
              )}
            </div>
            {nagerOn && (
              <Button
                variant="secondary"
                icon={<RefreshIcon />}
                onClick={handleRefreshHolidays}
                disabled={isRefreshing}
              >
                {isRefreshing ? 'Refreshing...' : 'Refresh'}
              </Button>
            )}
          </div>
        )}
        
        <p className={styles.help}>
          {nagerOn
            ? 'Bank holidays are fetched from the Nager public holiday API, and their names are in English.'
            : 'Fetching bank holidays from the Nager public holiday API is turned off; the holidays already imported stay.'}{' '}
          Custom holidays, edits and .ics imports are managed in{' '}
          <button
            type="button"
            className={styles.inlineLink}
            onClick={() => openSettings('bank-holidays', { type: 'view', siteId: site.id })}
          >
            Bank holidays
          </button>
          .
        </p>
      </div>
      
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button 
          variant="primary" 
          onClick={handleSave}
          loading={isSubmitting}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}
