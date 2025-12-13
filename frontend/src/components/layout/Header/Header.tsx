import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { SiteSelector } from './SiteSelector';
import { ViewModeControls } from './ViewModeControls';
import { ZoomControls } from './ZoomControls';
import { DateNavigation } from './DateNavigation';
import { UserMenu } from './UserMenu';
import { ThemeToggle } from './ThemeToggle';
import { WhatIfToggle } from './WhatIfToggle';
import { InstanceTitle } from './InstanceTitle';
import { getTheme } from '@/utils/storage';
import styles from './Header.module.css';

export function Header() {
  const currentUser = useAppStore((s) => s.currentUser);
  const whatIfMode = useAppStore((s) => s.whatIfMode);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => getTheme());

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const currentTheme = document.documentElement.dataset.theme as 'dark' | 'light';
      if (currentTheme && currentTheme !== theme) {
        setTheme(currentTheme);
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, [theme]);

  const canUseWhatIf =
    currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  const logoSrc = theme === 'dark' 
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';

  return (
    <header className={`${styles.header} ${whatIfMode ? styles.whatIfActive : ''}`}>
      <div className={styles.left}>
        <div className={styles.logo}>
          <img
            src={logoSrc}
            alt="Milestone"
            className={styles.logoImg}
          />
        </div>
        <InstanceTitle />
      </div>

      <div className={styles.center}>
        <DateNavigation />
        {canUseWhatIf && <WhatIfToggle />}
      </div>

      <div className={styles.right}>
        <SiteSelector />
        <ViewModeControls />
        <ZoomControls />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
