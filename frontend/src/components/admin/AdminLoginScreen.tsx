/**
 * Admin Login Screen
 * Authentication for multi-tenant admin panel
 */

import { useState, FormEvent, useEffect } from 'react';
import { adminLogin } from '@/api';
import { useAdminStore } from '@/stores/adminStore';
import { getTheme } from '@/utils/storage';
import styles from './AdminLogin.module.css';

export function AdminLoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => getTheme());
  
  const setAdminUser = useAdminStore((s) => s.setAdminUser);
  const setIsAuthenticated = useAdminStore((s) => s.setIsAuthenticated);
  const setIsLoading = useAdminStore((s) => s.setIsLoading);

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await adminLogin(email, password);
      if (response.success && response.user) {
        setAdminUser(response.user);
        setIsAuthenticated(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    } finally {
      setIsSubmitting(false);
      setIsLoading(false);
    }
  };

  const logoSrc = theme === 'dark'
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <img src={logoSrc} alt="Milestone" className={styles.logo} />
          <h1 className={styles.title}>Admin Portal</h1>
          <p className={styles.subtitle}>Multi-tenant Management</p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.formGroup}>
            <label htmlFor="email" className={styles.label}>Email</label>
            <input
              type="email"
              id="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              autoFocus
              disabled={isSubmitting}
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="password" className={styles.label}>Password</label>
            <input
              type="password"
              id="password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              disabled={isSubmitting}
            />
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className={styles.footer}>
          <a href="/" className={styles.backLink}>
            ← Back to Application
          </a>
        </div>
      </div>
    </div>
  );
}
