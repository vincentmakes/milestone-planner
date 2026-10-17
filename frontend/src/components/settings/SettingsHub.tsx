/**
 * SettingsHub
 *
 * One "Settings" window for everything admins and superusers configure: a
 * grouped section list on the left, the active section's panel on the right.
 * Sections come from SETTINGS_SECTIONS and are filtered by the current user's
 * role. The active section lives in uiStore (openSettings / legacy modal keys).
 *
 * A panel with unsaved changes reports it through onDirtyChange; the hub then
 * asks before switching section or closing.
 */

import { Suspense, useCallback, useMemo, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { Modal } from '@/components/common/Modal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { getVisibleSections, groupSections } from './sections';
import type { SettingsSectionId } from './types';
import styles from './SettingsHub.module.css';

const DISCARD_ON_SWITCH = 'You have unsaved changes. Discard them and switch section?';
const DISCARD_ON_CLOSE = 'You have unsaved changes. Are you sure you want to close?';

export function SettingsHub() {
  const activeModal = useUIStore((s) => s.activeModal);
  const settingsSection = useUIStore((s) => s.settingsSection);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);
  const closeModal = useUIStore((s) => s.closeModal);
  const role = useAppStore((s) => s.currentUser?.role);

  const isOpen = activeModal === 'settingsHub';

  const visibleSections = useMemo(() => getVisibleSections(role), [role]);
  const groups = useMemo(() => groupSections(visibleSections), [visibleSections]);
  // A section the role may not open (or none yet) falls back to the first one
  const active = visibleSections.find((s) => s.id === settingsSection) ?? visibleSections[0];

  const dirtyRef = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const selectSection = (id: SettingsSectionId) => {
    if (id === active?.id) return;
    if (dirtyRef.current && !window.confirm(DISCARD_ON_SWITCH)) return;
    dirtyRef.current = false;
    setSettingsSection(id);
  };

  const handleClose = useCallback(() => {
    if (dirtyRef.current && !window.confirm(DISCARD_ON_CLOSE)) return;
    dirtyRef.current = false;
    closeModal();
  }, [closeModal]);

  // Plain users have no section to open
  if (!isOpen || !active) return null;

  const ActivePanel = active.Panel;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Settings" size="wide" flushBody>
      <div className={styles.hub}>
        <nav className={styles.nav} aria-label="Settings sections">
          {groups.map(({ group, sections }) => (
            <div key={group} className={styles.group}>
              <div className={styles.groupLabel}>{group}</div>
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`${styles.navItem} ${section.id === active.id ? styles.active : ''}`}
                  aria-current={section.id === active.id ? 'page' : undefined}
                  onClick={() => selectSection(section.id)}
                >
                  <span className={styles.navIcon}>{section.icon}</span>
                  <span className={styles.navLabel}>{section.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Narrow screens: the list collapses into a select */}
        <div className={styles.compactNav}>
          <label className={styles.compactLabel} htmlFor="settings-section-select">
            Section
          </label>
          <select
            id="settings-section-select"
            className={styles.compactSelect}
            value={active.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              selectSection(e.target.value as SettingsSectionId)
            }
          >
            {groups.map(({ group, sections }) => (
              <optgroup key={group} label={group}>
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <section className={styles.content} aria-labelledby="settings-section-title">
          <header className={styles.contentHeader}>
            <h3 id="settings-section-title" className={styles.contentTitle}>
              {active.label}
            </h3>
            {active.description && (
              <p className={styles.contentDescription}>{active.description}</p>
            )}
          </header>
          <div className={styles.panel}>
            <Suspense fallback={<div className={styles.loading}>Loading…</div>}>
              <ActivePanel key={active.id} onDirtyChange={handleDirtyChange} />
            </Suspense>
          </div>
        </section>
      </div>
    </Modal>
  );
}
