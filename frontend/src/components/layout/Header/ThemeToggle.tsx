import { useState, useEffect } from 'react';
import { getTheme, toggleThemeMode, isDarkTheme, type Theme } from '@/utils/storage';
import styles from './ThemeToggle.module.css';
import { Icon, MoonIcon, SunIcon } from '@/components/common/Icon';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => getTheme());

  useEffect(() => {
    // Watch for external theme changes
    const observer = new MutationObserver(() => {
      const currentTheme = document.documentElement.dataset.theme as Theme;
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

  const handleToggle = () => {
    const newTheme = toggleThemeMode();
    setTheme(newTheme);
  };

  const isDark = isDarkTheme(theme);

  return (
    <button
      className={styles.button}
      onClick={handleToggle}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      {isDark ? (
        <Icon icon={SunIcon} size={18} />
      ) : (
        <Icon icon={MoonIcon} size={18} />
      )}
    </button>
  );
}
