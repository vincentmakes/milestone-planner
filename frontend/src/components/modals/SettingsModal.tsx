/**
 * SettingsModal
 * 
 * Modal for configuring instance-level settings like title, 
 * default views, custom logos, and other application preferences.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { getSetting, updateSetting } from '@/api/endpoints/settings';
import { 
  getThemeFamily, 
  setThemeFamily, 
  THEME_FAMILIES,
  type ThemeFamily 
} from '@/utils/storage';
import styles from './SettingsModal.module.css';

interface SettingsData {
  instance_title: string;
  default_view: string;
  week_start: string;
  show_weekends: string;
  auto_expand_projects: string;
  header_logo_dark: string;
  header_logo_light: string;
}

const DEFAULT_SETTINGS: SettingsData = {
  instance_title: '',
  default_view: 'month',
  week_start: 'monday',
  show_weekends: 'true',
  auto_expand_projects: 'false',
  header_logo_dark: '',
  header_logo_light: '',
};

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

export function SettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const instanceSettings = useAppStore((s) => s.instanceSettings);
  const setInstanceSettings = useAppStore((s) => s.setInstanceSettings);
  
  const isOpen = activeModal === 'settings';
  
  // State
  const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [originalSettings, setOriginalSettings] = useState<SettingsData>(DEFAULT_SETTINGS);
  const [themeFamily, setThemeFamilyState] = useState<ThemeFamily>(() => getThemeFamily());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Load settings when modal opens
  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);
  
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
      
      setSettings(loaded);
      setOriginalSettings(loaded);
    } catch (err) {
      setError('Failed to load settings');
      console.error('Load settings error:', err);
    } finally {
      setIsLoading(false);
    }
  };
  
  // Memoize hasChanges to prevent unnecessary re-renders
  const hasChanges = useMemo(() => {
    return JSON.stringify(settings) !== JSON.stringify(originalSettings);
  }, [settings, originalSettings]);
  
  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    
    try {
      // Save changed settings
      for (const key of Object.keys(settings) as (keyof SettingsData)[]) {
        if (settings[key] !== originalSettings[key]) {
          await updateSetting(key, settings[key]);
        }
      }
      
      // Update instance settings in app state
      const newInstanceSettings = {
        ...instanceSettings,
        instance_title: settings.instance_title,
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
      setIsSaving(false);
    }
  };
  
  const handleReset = useCallback(() => {
    setSettings(originalSettings);
    setSuccess(null);
    setError(null);
  }, [originalSettings]);
  
  const handleClose = useCallback(() => {
    if (hasChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to close?')) {
        return;
      }
    }
    closeModal();
  }, [hasChanges, closeModal]);
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Settings"
      size="md"
    >
      <div className={styles.container}>
        {isLoading ? (
          <div className={styles.loading}>Loading settings...</div>
        ) : (
          <>
            {/* Instance Settings Section */}
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Instance</h3>
              
              <div className={styles.field}>
                <label className={styles.label} htmlFor="instance-title">
                  Application Title
                </label>
                <input
                  id="instance-title"
                  type="text"
                  className={styles.input}
                  value={settings.instance_title}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSettings(prev => ({ ...prev, instance_title: value }));
                    setSuccess(null);
                  }}
                  placeholder="Milestone"
                  autoComplete="off"
                />
                <span className={styles.hint}>
                  Displayed in the header and browser tab
                </span>
              </div>
            </section>
            
            {/* Appearance Section */}
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
                  Use the sun/moon toggle in the header to switch between light and dark modes
                </span>
              </div>
            </section>
            
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
                    }}
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
                    }}
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
                    Display Saturday and Sunday columns in the timeline
                  </span>
                </div>
                <button
                  type="button"
                  className={`${styles.toggle} ${settings.show_weekends === 'true' ? styles.toggleOn : ''}`}
                  onClick={() => {
                    setSettings(prev => ({
                      ...prev,
                      show_weekends: prev.show_weekends === 'true' ? 'false' : 'true'
                    }));
                    setSuccess(null);
                  }}
                >
                  <span className={styles.toggleSlider} />
                </button>
              </div>
              
              <div className={styles.toggleField}>
                <div className={styles.toggleInfo}>
                  <label className={styles.label}>Auto-expand Projects</label>
                  <span className={styles.hint}>
                    Automatically expand projects to show phases on load
                  </span>
                </div>
                <button
                  type="button"
                  className={`${styles.toggle} ${settings.auto_expand_projects === 'true' ? styles.toggleOn : ''}`}
                  onClick={() => {
                    setSettings(prev => ({
                      ...prev,
                      auto_expand_projects: prev.auto_expand_projects === 'true' ? 'false' : 'true'
                    }));
                    setSuccess(null);
                  }}
                >
                  <span className={styles.toggleSlider} />
                </button>
              </div>
            </section>
            
            {/* Messages */}
            {error && (
              <div className={styles.error}>{error}</div>
            )}
            
            {success && (
              <div className={styles.success}>{success}</div>
            )}
            
            {/* Actions */}
            <div className={styles.actions}>
              <Button variant="secondary" onClick={handleClose}>
                Cancel
              </Button>
              <div className={styles.rightActions}>
                {hasChanges && (
                  <Button variant="ghost" onClick={handleReset}>
                    Reset
                  </Button>
                )}
                <Button 
                  onClick={handleSave} 
                  disabled={!hasChanges || isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// =============================================================================
// LOGO UPLOADER COMPONENT
// =============================================================================

interface LogoUploaderProps {
  value: string;
  onChange: (value: string) => void;
  theme: 'dark' | 'light';
}

function LogoUploader({ value, onChange, theme }: LogoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  
  const defaultLogo = theme === 'dark'
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';
  
  const handleFile = useCallback((file: File) => {
    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      alert('Please upload a PNG, JPG, SVG, or WebP image');
      return;
    }
    
    // Validate file size (max 500KB)
    if (file.size > 500 * 1024) {
      alert('Logo must be smaller than 500KB');
      return;
    }
    
    // Convert to base64
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      onChange(result);
    };
    reader.readAsDataURL(file);
  }, [onChange]);
  
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Remove
        </button>
      )}
    </div>
  );
}
