import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { SiteSelector } from './SiteSelector';
import { DateNavigation } from './DateNavigation';
import { UserMenu } from './UserMenu';
import { ThemeToggle } from './ThemeToggle';
import { WhatIfToggle } from './WhatIfToggle';
import { InstanceTitle } from './InstanceTitle';
import { UndoRedoControls } from './UndoRedoControls';
import { ViewModeControls } from './ViewModeControls';
import { ZoomControls } from './ZoomControls';
import { HeaderOverflowMenu, OverflowRow } from './HeaderOverflowMenu';
import { OnlineUsers } from '@/components/common/OnlineUsers';
import { NotificationBell } from '@/components/common/NotificationBell';
import { useHeaderDensity, type HeaderDensity } from '@/hooks/useHeaderDensity';
import { getTheme, isDarkTheme, type Theme } from '@/utils/storage';
import { getSetting } from '@/api/endpoints/settings';
import styles from './Header.module.css';

/**
 * Which controls leave the bar for the overflow menu, per density tier.
 *
 * This table is the whole responsive contract: every control renders in
 * exactly one place at any width, and nothing is ever simply dropped. Adding a
 * control to the bar means giving it a row here — see useHeaderDensity for the
 * width budget behind the tiers.
 */
type HeaderControl = 'zoom' | 'undoRedo' | 'viewModes' | 'theme' | 'whatIf';

/** Avatars before the "+N" chip takes over. */
const AVATARS_SHOWN: Record<HeaderDensity, number> = {
  full: 3,
  compact: 3,
  condensed: 2,
  minimal: 1,
};

const IN_OVERFLOW_MENU: Record<HeaderDensity, ReadonlySet<HeaderControl>> = {
  full: new Set(),
  compact: new Set(),
  // Zoom and undo/redo go first: both already have keyboard equivalents in
  // useKeyboardShortcuts (`+`/`-`, Ctrl+Z / Ctrl+Y). View modes have none.
  condensed: new Set(['zoom', 'undoRedo']),
  minimal: new Set(['zoom', 'undoRedo', 'viewModes', 'theme', 'whatIf']),
};

export function Header() {
  const currentUser = useAppStore((s) => s.currentUser);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const currentView = useViewStore((s) => s.currentView);
  const showStaffOverview = useViewStore((s) => s.showStaffOverview);
  const showEquipmentOverview = useViewStore((s) => s.showEquipmentOverview);
  const toggleShowStaffOverview = useViewStore((s) => s.toggleShowStaffOverview);
  const toggleShowEquipmentOverview = useViewStore((s) => s.toggleShowEquipmentOverview);
  
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [customLogoDark, setCustomLogoDark] = useState<string>('');
  const [customLogoLight, setCustomLogoLight] = useState<string>('');
  const [showPanelsDropdown, setShowPanelsDropdown] = useState(false);
  const panelsDropdownRef = useRef<HTMLDivElement>(null);

  // Load custom logos
  useEffect(() => {
    const loadCustomLogos = async () => {
      try {
        const [darkResult, lightResult] = await Promise.all([
          getSetting('header_logo_dark').catch(() => ({ value: null })),
          getSetting('header_logo_light').catch(() => ({ value: null })),
        ]);
        if (darkResult.value) setCustomLogoDark(darkResult.value);
        if (lightResult.value) setCustomLogoLight(lightResult.value);
      } catch (err) {
        // Use default logos on error
      }
    };
    loadCustomLogos();
  }, []);

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const currentTheme = document.documentElement.dataset.theme as Theme;
      if (currentTheme && currentTheme !== theme) {
        setThemeState(currentTheme);
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, [theme]);

  // Close panels dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelsDropdownRef.current && !panelsDropdownRef.current.contains(e.target as Node)) {
        setShowPanelsDropdown(false);
      }
    };
    if (showPanelsDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPanelsDropdown]);

  const canUseWhatIf = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  const canShowPanels = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  const isGanttView = currentView === 'gantt';
  // Every view except Kanban renders a timeline, so date navigation, the view-mode
  // switcher, undo/redo and zoom belong to all of them but the board.
  const isTimelineView = currentView !== 'kanban';

  const density = useHeaderDensity();
  const inMenu = IN_OVERFLOW_MENU[density];

  // Determine logo source
  const logoSrc = useMemo(() => {
    const custom = isDarkTheme(theme) ? customLogoDark : customLogoLight;
    // A tenant's own logo is never substituted — only our own wordmark is
    // traded for the mark when the bar is tight.
    if (custom) return custom;
    if (density === 'minimal') return '/img/milestone_logo_no_text.svg';
    return isDarkTheme(theme)
      ? '/img/milestone_logo_dark_theme.svg'
      : '/img/milestone_logo_light_theme.svg';
  }, [theme, customLogoDark, customLogoLight, density]);

  // Count active panels
  const activePanelCount = (showStaffOverview ? 1 : 0) + (showEquipmentOverview ? 1 : 0);

  const menuRows = [
    isTimelineView && inMenu.has('viewModes') && (
      <OverflowRow key="view" label="View">
        <ViewModeControls />
      </OverflowRow>
    ),
    isTimelineView && inMenu.has('zoom') && (
      <OverflowRow key="zoom" label="Zoom">
        <ZoomControls />
      </OverflowRow>
    ),
    isTimelineView && inMenu.has('undoRedo') && (
      <OverflowRow key="history" label="History">
        <UndoRedoControls />
      </OverflowRow>
    ),
    inMenu.has('theme') && (
      <OverflowRow key="theme" label="Theme">
        <ThemeToggle />
      </OverflowRow>
    ),
    // Not while active — the active state stays in the bar instead.
    canUseWhatIf && inMenu.has('whatIf') && !whatIfMode && (
      <OverflowRow key="whatif" label="What If">
        <WhatIfToggle />
      </OverflowRow>
    ),
  ].filter(Boolean);

  return (
    <header
      className={`${styles.header} ${whatIfMode ? styles.whatIfActive : ''}`}
      // Every responsive rule in Header.module.css keys off this, so the
      // breakpoints stay in useHeaderDensity and out of the stylesheet.
      data-density={density}
    >
      {/* LEFT: Branding & Context */}
      <div className={styles.left}>
        <div className={styles.logo}>
          <img src={logoSrc} alt="Milestone" className={styles.logoImg} />
        </div>
        {/* Branding is the first thing to go: it costs ~150px and tells a
            returning user nothing they do not already know. */}
        {(density === 'full' || density === 'compact') && <InstanceTitle />}
        <div className={styles.divider} />
        <SiteSelector />
      </div>

      {/* CENTER: Timeline Controls */}
      <div className={styles.center}>
        {isTimelineView && (
          <>
            <DateNavigation shortLabel={density !== 'full'} />

            <div className={styles.divider} />

            {!inMenu.has('viewModes') && (
              <>
                <ViewModeControls />
                <div className={styles.divider} />
              </>
            )}

            {!inMenu.has('undoRedo') && (
              <>
                <UndoRedoControls />
                <div className={styles.divider} />
              </>
            )}

            {!inMenu.has('zoom') && <ZoomControls />}
          </>
        )}
      </div>

      {/* RIGHT: Actions & User */}
      <div className={styles.right}>
        {/* Panels Toggle (Staff/Equipment) - only for admins in Gantt view */}
        {canShowPanels && isGanttView && (
          <div ref={panelsDropdownRef} className={styles.panelsWrapper}>
            <button
              className={`${styles.panelsBtn} ${activePanelCount > 0 ? styles.hasActive : ''}`}
              onClick={() => setShowPanelsDropdown(!showPanelsDropdown)}
              title="Toggle overview panels"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="15" x2="21" y2="15" />
              </svg>
              <span>Panels</span>
              {activePanelCount > 0 && (
                <span className={styles.panelsBadge}>{activePanelCount}</span>
              )}
            </button>
            
            {showPanelsDropdown && (
              <div className={styles.panelsDropdown}>
                <div className={styles.panelsDropdownHeader}>Overview Panels</div>
                <div className={styles.panelButtons}>
                  <button
                    className={`${styles.panelToggleBtn} ${showStaffOverview ? styles.active : ''}`}
                    onClick={() => {
                      toggleShowStaffOverview();
                      setShowPanelsDropdown(false);
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    <span>Staff</span>
                  </button>
                  <button
                    className={`${styles.panelToggleBtn} ${styles.equipment} ${showEquipmentOverview ? styles.active : ''}`}
                    onClick={() => {
                      toggleShowEquipmentOverview();
                      setShowPanelsDropdown(false);
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                    </svg>
                    <span>Equipment</span>
                  </button>
                </div>
                <div className={styles.panelsHint}>
                  Click to toggle • Drag staff/equipment to assign
                </div>
              </div>
            )}
          </div>
        )}
        
        {/* What-If Toggle. Stays in the bar while active whatever the density:
            a pending sandbox with unapplied edits must never hide behind a menu. */}
        {canUseWhatIf && (!inMenu.has('whatIf') || whatIfMode) && <WhatIfToggle />}

        <div className={styles.divider} />

        {!inMenu.has('theme') && <ThemeToggle />}

        {/* Whatever no longer fits, reachable rather than dropped. The rows are
            collected first so the Kanban board — which has no timeline controls
            to demote — never shows an empty menu. */}
        {menuRows.length > 0 && <HeaderOverflowMenu>{menuRows}</HeaderOverflowMenu>}

        {/* Notifications */}
        <NotificationBell />

        {/* Online Users */}
        <OnlineUsers maxVisible={AVATARS_SHOWN[density]} />

        {/* User Menu */}
        <UserMenu />
      </div>
    </header>
  );
}
