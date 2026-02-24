import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { SiteSelector } from './SiteSelector';
import { DateNavigation } from './DateNavigation';
import { UserMenu } from './UserMenu';
import { ThemeToggle } from './ThemeToggle';
import { WhatIfToggle } from './WhatIfToggle';
import { InstanceTitle } from './InstanceTitle';
import { OnlineUsers } from '@/components/common/OnlineUsers';
import { getTheme, isDarkTheme, type Theme } from '@/utils/storage';
import { getSetting } from '@/api/endpoints/settings';
import type { ViewMode } from '@/types';
import styles from './Header.module.css';

// View mode options
const VIEW_MODES: { value: ViewMode; label: string; title: string }[] = [
  { value: 'week', label: 'W', title: 'Week view' },
  { value: 'month', label: 'M', title: 'Month view' },
  { value: 'quarter', label: 'Q', title: 'Quarter view' },
  { value: 'year', label: 'Y', title: 'Year view' },
];

// Zoom constants
const MIN_CELL_WIDTH = 12;
const MAX_CELL_WIDTH = 120;
const ZOOM_STEP = 4;
const DEFAULT_CELL_WIDTH = 36;

export function Header() {
  const currentUser = useAppStore((s) => s.currentUser);
  const whatIfMode = useAppStore((s) => s.whatIfMode);
  const currentView = useAppStore((s) => s.currentView);
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const setCellWidth = useAppStore((s) => s.setCellWidth);
  const showStaffOverview = useAppStore((s) => s.showStaffOverview);
  const showEquipmentOverview = useAppStore((s) => s.showEquipmentOverview);
  const toggleShowStaffOverview = useAppStore((s) => s.toggleShowStaffOverview);
  const toggleShowEquipmentOverview = useAppStore((s) => s.toggleShowEquipmentOverview);
  
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

  // Zoom calculations
  const zoomPercent = Math.round((cellWidth / DEFAULT_CELL_WIDTH) * 100);
  const canZoomIn = cellWidth < MAX_CELL_WIDTH;
  const canZoomOut = cellWidth > MIN_CELL_WIDTH;

  const handleZoomIn = () => {
    const newWidth = Math.min(cellWidth + ZOOM_STEP, MAX_CELL_WIDTH);
    if (newWidth !== cellWidth) setCellWidth(newWidth);
  };

  const handleZoomOut = () => {
    const newWidth = Math.max(cellWidth - ZOOM_STEP, MIN_CELL_WIDTH);
    if (newWidth !== cellWidth) setCellWidth(newWidth);
  };

  const handleResetZoom = () => {
    if (cellWidth !== DEFAULT_CELL_WIDTH) setCellWidth(DEFAULT_CELL_WIDTH);
  };

  // Determine logo source
  const logoSrc = useMemo(() => {
    if (isDarkTheme(theme)) {
      return customLogoDark || '/img/milestone_logo_dark_theme.svg';
    } else {
      return customLogoLight || '/img/milestone_logo_light_theme.svg';
    }
  }, [theme, customLogoDark, customLogoLight]);

  // Count active panels
  const activePanelCount = (showStaffOverview ? 1 : 0) + (showEquipmentOverview ? 1 : 0);

  return (
    <header className={`${styles.header} ${whatIfMode ? styles.whatIfActive : ''}`}>
      {/* LEFT: Branding & Context */}
      <div className={styles.left}>
        <div className={styles.logo}>
          <img src={logoSrc} alt="Milestone" className={styles.logoImg} />
        </div>
        <InstanceTitle />
        <div className={styles.divider} />
        <SiteSelector />
      </div>

      {/* CENTER: Timeline Controls */}
      <div className={styles.center}>
        <DateNavigation />
        
        <div className={styles.divider} />
        
        {/* View Mode Switcher */}
        <div className={styles.viewModes}>
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.value}
              className={`${styles.viewModeBtn} ${viewMode === mode.value ? styles.active : ''}`}
              onClick={() => setViewMode(mode.value)}
              title={mode.title}
            >
              {mode.label}
            </button>
          ))}
        </div>
        
        <div className={styles.divider} />
        
        {/* Zoom Controls */}
        <div className={styles.zoomControls}>
          <button
            className={styles.zoomBtn}
            onClick={handleZoomOut}
            disabled={!canZoomOut}
            title="Zoom out"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13H5v-2h14v2z" />
            </svg>
          </button>
          <button
            className={styles.zoomLevel}
            onClick={handleResetZoom}
            title="Reset zoom to 100%"
          >
            {zoomPercent}%
          </button>
          <button
            className={styles.zoomBtn}
            onClick={handleZoomIn}
            disabled={!canZoomIn}
            title="Zoom in"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
          </button>
        </div>
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
        
        {/* What-If Toggle */}
        {canUseWhatIf && <WhatIfToggle />}
        
        <div className={styles.divider} />
        
        {/* Theme Toggle */}
        <ThemeToggle />
        
        {/* Online Users */}
        <OnlineUsers />
        
        {/* User Menu */}
        <UserMenu />
      </div>
    </header>
  );
}
