/**
 * GeneralPanel (Settings hub > General)
 *
 * - Appearance: the per-browser theme family (localStorage), applied at once.
 *   Shown to everyone who can open the hub.
 * - Instance-level settings (title, branding, display defaults, Gantt options)
 *   are saved with PUT /settings, which only admins may call, so they and the
 *   Save button are rendered for admins only. Their unsaved changes are
 *   reported to the hub, which asks before switching section or closing.
 * - Data management (`system.audit_log`): an "Open audit log" row that shows
 *   the AuditLogPanel in place of the form, with a "Back to General" link —
 *   a panel-internal sub-view, like a Users edit form. The form stays mounted
 *   (hidden) meanwhile, so its unsaved edits survive the trip and keep the
 *   hub's guard armed; closing the hub unmounts both.
 */

import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Notice } from '@/components/common/Notice';
import type { ReactNode, Ref } from 'react';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useAppStore } from '@/stores/appStore';
import { getSetting, updateSetting } from '@/api/endpoints/settings';
import { 
  getThemeFamily, 
  setThemeFamily, 
  THEME_FAMILIES,
  type ThemeFamily 
} from '@/utils/storage';
import type { SettingsPanelProps } from '../types';
import styles from './GeneralPanel.module.css';
import { can } from '@/utils/permissions';
import { Icon, AdminPanelSettingsIcon, BackIcon, CloseIcon, UploadIcon } from '@/components/common/Icon';

const AuditLogPanel = lazy(() =>
  import('./audit-log/AuditLogPanel').then((m) => ({ default: m.AuditLogPanel }))
);

interface SettingsData {
  instance_title: string;
  default_view: string;
  week_start: string;
  show_weekends: string;
  /** Saturdays and Sundays are working days: exactly 'true' or 'false' (off by default) */
  weekend_working_days: string;
  auto_expand_projects: string;
  header_logo_dark: string;
  header_logo_light: string;
  /** Days the audit log keeps its entries, '0' = indefinitely */
  audit_log_retention_days: string;
}

const DEFAULT_SETTINGS: SettingsData = {
  instance_title: '',
  default_view: 'month',
  week_start: 'monday',
  show_weekends: 'true',
  weekend_working_days: 'false',
  auto_expand_projects: 'false',
  header_logo_dark: '',
  header_logo_light: '',
  audit_log_retention_days: '365',
};

/** The longest audit log retention the server accepts (`MAX_RETENTION_DAYS`). */
const MAX_RETENTION_DAYS = 3650;
/** What turning "Keep audit entries indefinitely" off restores. */
const DEFAULT_RETENTION_DAYS = '365';

/** Why a retention value would be refused, or null: a whole number from 0 to 3650. */
function retentionError(value: string): string | null {
  const text = value.trim();
  if (/^\d+$/.test(text) && Number(text) <= MAX_RETENTION_DAYS) return null;
  return `Enter a whole number of days from 0 to ${MAX_RETENTION_DAYS}.`;
}

const VIEW_OPTIONS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

const WEEK_START_OPTIONS = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
];

/** "Kept 365 days", or "Kept indefinitely" for 0, as the audit log's chip reads (a missing or malformed value is the default 365). */
function retentionText(value: string | undefined): string {
  const parsed = Number.parseInt(value ?? '', 10);
  const days = Number.isFinite(parsed) && parsed >= 0 ? parsed : 365;
  return days === 0 ? 'Kept indefinitely' : `Kept ${days} days`;
}

/** Resets the scrolled ancestor (the hub's content pane), so a sub-view opens at its top. */
function scrollAncestorToTop(element: HTMLElement | null): void {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (node.scrollTop > 0) {
      node.scrollTop = 0;
      return;
    }
  }
}

export function GeneralPanel({ onDirtyChange }: SettingsPanelProps) {
  const canEditInstance = useAppStore((s) => can(s.currentUser, 'settings.general'));
  const canViewAuditLog = useAppStore((s) => can(s.currentUser, 'system.audit_log'));
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  // Focus goes back to "Open audit log" on Back, not on the first render
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!auditLogOpen && returnFocus.current) {
      returnFocus.current = false;
      openButtonRef.current?.focus();
    }
  }, [auditLogOpen]);

  const auditLogRow = canViewAuditLog ? (
    <AuditLogRow buttonRef={openButtonRef} onOpen={() => setAuditLogOpen(true)} />
  ) : null;

  const form = canEditInstance ? (
    <InstanceSettingsForm
      onDirtyChange={onDirtyChange}
      appearance={<AppearanceSection />}
      auditLogRow={auditLogRow}
    />
  ) : (
    <div className={styles.container}>
      <AppearanceSection />
      {auditLogRow && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Data management</h3>
          {auditLogRow}
        </section>
      )}
      <p className={styles.hint}>
        Instance-wide settings (title, branding, display defaults) are managed by administrators.
      </p>
    </div>
  );

  return (
    <>
      <div hidden={auditLogOpen}>{form}</div>
      {auditLogOpen && (
        <AuditLogView
          onBack={() => {
            returnFocus.current = true;
            setAuditLogOpen(false);
          }}
        />
      )}
    </>
  );
}

// =============================================================================
// AUDIT LOG (Data management row and sub-view, system.audit_log)
// =============================================================================

interface AuditLogRowProps {
  buttonRef: Ref<HTMLButtonElement>;
  onOpen: () => void;
}

function AuditLogRow({ buttonRef, onOpen }: AuditLogRowProps) {
  const retention = useAppStore((s) => s.instanceSettings?.audit_log_retention_days);

  return (
    <div className={styles.toggleField}>
      <div className={styles.toggleInfo}>
        <span className={styles.label}>Audit log</span>
        <span className={styles.hint}>Who signed in, what changed and who exported what.</span>
        <span className={styles.hint}>{retentionText(retention)}</span>
      </div>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        icon={<Icon icon={AdminPanelSettingsIcon} />}
        onClick={onOpen}
      >
        Open audit log
      </Button>
    </div>
  );
}

function AuditLogView({ onBack }: { onBack: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    scrollAncestorToTop(rootRef.current);
    backRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={rootRef} className={styles.subView}>
      <div className={styles.subViewHeader}>
        <h3>Audit log</h3>
        <Button ref={backRef} type="button" variant="ghost" icon={<Icon icon={BackIcon} />} onClick={onBack}>
          Back to General
        </Button>
      </div>
      <Suspense fallback={<div className={styles.loading}>Loading…</div>}>
        <AuditLogPanel />
      </Suspense>
    </div>
  );
}

// =============================================================================
// APPEARANCE (per browser)
// =============================================================================

function AppearanceSection() {
  const [themeFamily, setThemeFamilyState] = useState<ThemeFamily>(() => getThemeFamily());

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Appearance</h3>

      <div className={styles.field}>
        <label className={styles.label}>Theme</label>
        <div className={styles.themeOptions}>
          {THEME_FAMILIES.map(family => (
            <button
              key={family.id}
              type="button"
              className={`${styles.themeOption} ${themeFamily === family.id ? styles.selected : ''}`}
              onClick={() => {
                setThemeFamilyState(family.id);
                setThemeFamily(family.id);
              }}
            >
              <span className={styles.themeName}>{family.name}</span>
              <span className={styles.themeDescription}>{family.description}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>
          Applies to this browser only. Use the sun/moon toggle in the header to switch between
          light and dark modes
        </span>
      </div>
    </section>
  );
}

// =============================================================================
// INSTANCE SETTINGS (admin only)
// =============================================================================

interface InstanceSettingsFormProps extends SettingsPanelProps {
  /** Rendered between the Instance and Branding sections */
  appearance: ReactNode;
  /** The "Open audit log" row, first in Data management (null without system.audit_log) */
  auditLogRow: ReactNode;
}

function InstanceSettingsForm({ onDirtyChange, appearance, auditLogRow }: InstanceSettingsFormProps) {
  const instanceSettings = useAppStore((s) => s.instanceSettings);
  const setInstanceSettings = useAppStore((s) => s.setInstanceSettings);
  
  // State
  const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [originalSettings, setOriginalSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const { isSubmitting: isSaving, begin: beginSave, end: endSave } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Load settings when the panel opens
  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // Load each setting
        const loaded: SettingsData = { ...DEFAULT_SETTINGS };
        
        for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) {
          try {
            const response = await getSetting(key);
            if (response.value !== null) {
              loaded[key] = response.value;
            }
          } catch {
            // Use default if setting doesn't exist
          }
        }
        
        if (cancelled) return;
        setSettings(loaded);
        setOriginalSettings(loaded);
      } catch (err) {
        if (!cancelled) setError('Failed to load settings');
        console.error('Load settings error:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);
  
  // Memoize hasChanges to prevent unnecessary re-renders
  const hasChanges = useMemo(() => {
    return JSON.stringify(settings) !== JSON.stringify(originalSettings);
  }, [settings, originalSettings]);
  
  // Tell the hub about unsaved changes (and clear the flag when leaving)
  useEffect(() => {
    onDirtyChange(hasChanges);
  }, [hasChanges, onDirtyChange]);
  
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  
  const retentionProblem = retentionError(settings.audit_log_retention_days);
  const keepForever = retentionProblem === null && Number(settings.audit_log_retention_days.trim()) === 0;

  const handleSave = async () => {
    if (!beginSave()) return; // a save is already running
    setError(null);
    setSuccess(null);
    
    try {
      // Save changed settings
      for (const key of Object.keys(settings) as (keyof SettingsData)[]) {
        if (settings[key] !== originalSettings[key]) {
          await updateSetting(key, key === 'audit_log_retention_days' ? settings[key].trim() : settings[key]);
        }
      }
      
      // Update instance settings in app state
      const newInstanceSettings = {
        ...instanceSettings,
        instance_title: settings.instance_title,
        show_weekends: settings.show_weekends,
        weekend_working_days: settings.weekend_working_days,
        audit_log_retention_days: settings.audit_log_retention_days.trim(),
      };
      setInstanceSettings(newInstanceSettings);
      
      // Update browser tab title
      const title = settings.instance_title || 'Milestone';
      document.title = title;
      
      setOriginalSettings(settings);
      setSuccess('Settings saved successfully');
    } catch (err) {
      setError('Failed to save settings');
      console.error('Save settings error:', err);
    } finally {
      endSave();
    }
  };
  
  const handleReset = useCallback(() => {
    setSettings(originalSettings);
    setSuccess(null);
    setError(null);
  }, [originalSettings]);
  
  return (
    <div className={styles.container}>
      {isLoading ? (
        <div className={styles.loading}>Loading settings...</div>
      ) : (
        <>
          {/* Instance Settings Section */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Instance</h3>
            
            <Input
              label="Application Title"
              hint="Displayed in the header and browser tab"
              fullWidth
              id="instance-title"
              type="text"
              value={settings.instance_title}
              onChange={(e) => {
                const value = e.target.value;
                setSettings(prev => ({ ...prev, instance_title: value }));
                setSuccess(null);
              }}
              placeholder="Milestone"
              autoComplete="off"
            />
          </section>
          
          {/* Appearance Section (per browser) */}
          {appearance}
          
          {/* Branding Section - Logo Upload */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Branding</h3>
            
            <div className={styles.logoSection}>
              <div className={styles.logoField}>
                <label className={styles.label}>Dark Theme Logo</label>
                <LogoUploader
                  value={settings.header_logo_dark}
                  onChange={(value) => {
                    setSettings(prev => ({ ...prev, header_logo_dark: value }));
                    setSuccess(null);
                    setError(null);
                  }}
                  onError={setError}
                  theme="dark"
                />
                <span className={styles.hint}>
                  Used when dark theme is active
                </span>
              </div>
              
              <div className={styles.logoField}>
                <label className={styles.label}>Light Theme Logo</label>
                <LogoUploader
                  value={settings.header_logo_light}
                  onChange={(value) => {
                    setSettings(prev => ({ ...prev, header_logo_light: value }));
                    setSuccess(null);
                    setError(null);
                  }}
                  onError={setError}
                  theme="light"
                />
                <span className={styles.hint}>
                  Used when light theme is active
                </span>
              </div>
            </div>
          </section>
          
          {/* Display Settings Section */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Display</h3>
            
            <div className={styles.field}>
              <label className={styles.label}>Default View</label>
              <div className={styles.buttonGroup}>
                {VIEW_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.optionButton} ${settings.default_view === opt.value ? styles.selected : ''}`}
                    onClick={() => {
                      setSettings(prev => ({ ...prev, default_view: opt.value }));
                      setSuccess(null);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            
            <div className={styles.field}>
              <label className={styles.label}>Week Starts On</label>
              <div className={styles.buttonGroup}>
                {WEEK_START_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.optionButton} ${settings.week_start === opt.value ? styles.selected : ''}`}
                    onClick={() => {
                      setSettings(prev => ({ ...prev, week_start: opt.value }));
                      setSuccess(null);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
          
          {/* Gantt Settings Section */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Gantt Chart</h3>
            
            <div className={styles.toggleField}>
              <div className={styles.toggleInfo}>
                <label className={styles.label}>Show Weekends</label>
                <span className={styles.hint}>
                  Display Saturday and Sunday columns in the timeline. Whether they count as working days is the
                  setting below.
                </span>
              </div>
              <ToggleSwitch
                checked={settings.show_weekends === 'true'}
                aria-label="Show Weekends"
                onChange={(on) => {
                  setSettings(prev => ({ ...prev, show_weekends: on ? 'true' : 'false' }));
                  setSuccess(null);
                }}
              />
            </div>

            <div className={styles.toggleField}>
              <div className={styles.toggleInfo}>
                <label className={styles.label}>Weekends are working days</label>
                <span className={styles.hint}>
                  Count Saturday and Sunday as working days in dashboards, capacity and availability. Off: Monday to
                  Friday only.
                </span>
              </div>
              <ToggleSwitch
                checked={settings.weekend_working_days === 'true'}
                aria-label="Weekends are working days"
                onChange={(on) => {
                  setSettings(prev => ({ ...prev, weekend_working_days: on ? 'true' : 'false' }));
                  setSuccess(null);
                }}
              />
            </div>
            
            <div className={styles.toggleField}>
              <div className={styles.toggleInfo}>
                <label className={styles.label}>Auto-expand Projects</label>
                <span className={styles.hint}>
                  Automatically expand projects to show phases on load
                </span>
              </div>
              <ToggleSwitch
                checked={settings.auto_expand_projects === 'true'}
                aria-label="Auto-expand Projects"
                onChange={(on) => {
                  setSettings(prev => ({ ...prev, auto_expand_projects: on ? 'true' : 'false' }));
                  setSuccess(null);
                }}
              />
            </div>
          </section>
          
          {/* Data management: the audit log and its retention */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Data management</h3>

            {auditLogRow}

            <div className={styles.field}>
              <span className={styles.label}>Audit log retention</span>
              <div className={styles.retentionRow}>
                <Input
                  className={styles.retentionInput}
                  fullWidth
                  label="Retention period (days)"
                  hint="0 = keep indefinitely. Maximum 3650 days."
                  error={retentionProblem ?? undefined}
                  id="audit-log-retention-days"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_RETENTION_DAYS}
                  step={1}
                  value={settings.audit_log_retention_days}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSettings(prev => ({ ...prev, audit_log_retention_days: value }));
                    setSuccess(null);
                  }}
                />
                <ToggleSwitch
                  label="Keep audit entries indefinitely"
                  checked={keepForever}
                  onChange={(on) => {
                    setSettings(prev => ({
                      ...prev,
                      audit_log_retention_days: on ? '0' : DEFAULT_RETENTION_DAYS,
                    }));
                    setSuccess(null);
                  }}
                />
              </div>
            </div>
          </section>

          {/* Messages */}
          {error && (
            <Notice tone="error">{error}</Notice>
          )}
          
          {success && (
            <div className={styles.success}>{success}</div>
          )}
          
          {/* Actions */}
          <div className={styles.actions}>
            <span className={styles.hint}>
              {hasChanges ? 'You have unsaved changes' : ''}
            </span>
            <div className={styles.rightActions}>
              {hasChanges && (
                <Button variant="ghost" onClick={handleReset}>
                  Reset
                </Button>
              )}
              <Button 
                onClick={handleSave} 
                disabled={!hasChanges || isSaving || retentionProblem !== null}
                loading={isSaving}
              >
                Save Changes
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// LOGO UPLOADER COMPONENT
// =============================================================================

interface LogoUploaderProps {
  value: string;
  onChange: (value: string) => void;
  /** A rejected file is reported here and shown by the panel's Notice. */
  onError: (message: string) => void;
  theme: 'dark' | 'light';
}

function LogoUploader({ value, onChange, onError, theme }: LogoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  
  const defaultLogo = theme === 'dark'
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';
  
  const handleFile = useCallback((file: File) => {
    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      onError('Please upload a PNG, JPG, SVG, or WebP image');
      return;
    }
    
    // Validate file size (max 500KB)
    if (file.size > 500 * 1024) {
      onError('Logo must be smaller than 500KB');
      return;
    }
    
    // Convert to base64
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      onChange(result);
    };
    reader.readAsDataURL(file);
  }, [onChange, onError]);
  
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);
  
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);
  
  const handleRemove = useCallback(() => {
    onChange('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [onChange]);
  
  const displaySrc = value || defaultLogo;
  const hasCustomLogo = !!value;
  
  return (
    <div className={styles.logoUploader}>
      <div 
        className={`${styles.logoPreview} ${styles[theme]} ${dragActive ? styles.dragActive : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <img 
          src={displaySrc} 
          alt={`${theme} theme logo`}
          className={styles.logoImage}
        />
        <div className={styles.logoOverlay}>
          <Icon icon={UploadIcon} size={20} />
          <span>Upload</span>
        </div>
      </div>
      
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        onChange={handleInputChange}
        className={styles.logoInput}
      />
      
      {hasCustomLogo && (
        <button
          type="button"
          className={styles.logoRemoveBtn}
          onClick={(e) => {
            e.stopPropagation();
            handleRemove();
          }}
          title="Remove custom logo"
        >
          <Icon icon={CloseIcon} size={14} />
          Remove
        </button>
      )}
    </div>
  );
}
