/**
 * SettingsModal
 * 
 * Modal for configuring instance-level settings like title, 
 * default views, and other application preferences.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { getSetting, updateSetting } from '@/api/endpoints/settings';
import styles from './SettingsModal.module.css';

interface SettingsData {
  instance_title: string;
  default_view: string;
  week_start: string;
  date_format: string;
  show_weekends: string;
  auto_expand_projects: string;
}

const DEFAULT_SETTINGS: SettingsData = {
  instance_title: '',
  default_view: 'month',
  week_start: 'monday',
  date_format: 'dd/mm/yyyy',
  show_weekends: 'true',
  auto_expand_projects: 'false',
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

const DATE_FORMAT_OPTIONS = [
  { value: 'dd/mm/yyyy', label: 'DD/MM/YYYY (31/12/2025)' },
  { value: 'mm/dd/yyyy', label: 'MM/DD/YYYY (12/31/2025)' },
  { value: 'yyyy-mm-dd', label: 'YYYY-MM-DD (2025-12-31)' },
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
                <label className={styles.label}>Date Format</label>
                <select
                  className={styles.select}
                  value={settings.date_format}
                  onChange={(e) => {
                    setSettings(prev => ({ ...prev, date_format: e.target.value }));
                    setSuccess(null);
                  }}
                >
                  {DATE_FORMAT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
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
