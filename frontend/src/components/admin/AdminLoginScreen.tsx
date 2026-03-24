/**
 * Admin Login Screen
 * Authentication for multi-tenant admin panel
 * Includes forced password change on first login
 */

import { useState, FormEvent, useEffect } from 'react';
import { adminLogin, changeAdminPassword } from '@/api';
import { useAdminStore } from '@/stores/adminStore';
import { getTheme, isDarkTheme, type Theme } from '@/utils/storage';
import styles from './AdminLogin.module.css';

export function AdminLoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  // Password change state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeSuccess, setChangeSuccess] = useState(false);

  const setAdminUser = useAdminStore((s) => s.setAdminUser);
  const setIsAuthenticated = useAdminStore((s) => s.setIsAuthenticated);
  const setIsLoading = useAdminStore((s) => s.setIsLoading);
  const setMustChangePassword = useAdminStore((s) => s.setMustChangePassword);

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await adminLogin(email, password);
      if (response.success && response.user) {
        if (response.must_change_password) {
          // Show password change form instead of completing login
          setShowChangePassword(true);
          setCurrentPassword(password);
          setAdminUser(response.user);
          setMustChangePassword(true);
        } else {
          setAdminUser(response.user);
          setIsAuthenticated(true);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    } finally {
      setIsSubmitting(false);
      setIsLoading(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsSubmitting(true);

    try {
      await changeAdminPassword(currentPassword, newPassword);
      setChangeSuccess(true);
      setMustChangePassword(false);
      // Brief delay so the user sees the success message
      setTimeout(() => {
        setIsAuthenticated(true);
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setIsSubmitting(false);
    }
  };

  const logoSrc = isDarkTheme(theme)
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';

  if (showChangePassword) {
    return (
      <div className={styles.container}>
        <div className={styles.card}>
          <div className={styles.header}>
            <img src={logoSrc} alt="Milestone" className={styles.logo} />
            <h1 className={styles.title}>Change Password</h1>
            <p className={styles.subtitle}>You must set a new password before continuing</p>
          </div>

          {changeSuccess ? (
            <div className={styles.success}>
              Password changed successfully. Redirecting...
            </div>
          ) : (
            <form onSubmit={handleChangePassword} className={styles.form}>
              <div className={styles.formGroup}>
                <label htmlFor="newPassword" className={styles.label}>New Password</label>
                <input
                  type="password"
                  id="newPassword"
                  className={styles.input}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  required
                  minLength={8}
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="confirmPassword" className={styles.label}>Confirm Password</label>
                <input
                  type="password"
                  id="confirmPassword"
                  className={styles.input}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  required
                  minLength={8}
                  disabled={isSubmitting}
                />
              </div>

              {error && <div className={styles.error}>{error}</div>}

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Changing...' : 'Set New Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

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
