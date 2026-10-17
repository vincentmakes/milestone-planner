/**
 * Login Screen
 * Authentication form with SSO support
 */

import { useState, FormEvent, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { checkSSOEnabled, getSSOLoginUrl } from '@/api';
import { getTheme, isDarkTheme, type Theme } from '@/utils/storage';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import styles from './LoginScreen.module.css';

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  // Surface the reason a failed SSO round-trip sent the user back here. The
  // callback appends ?sso_error=... to the tenant login URL; strip it once read
  // so a reload doesn't resurrect a stale message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get('sso_error');
    if (!ssoError) return;

    setError(ssoError);
    params.delete('sso_error');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    );
  }, []);

  // Check if SSO is enabled
  useEffect(() => {
    const checkSSO = async () => {
      try {
        const { enabled } = await checkSSOEnabled();
        setSsoEnabled(enabled);
      } catch {
        // SSO not available
      }
    };
    checkSSO();
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!beginSubmit()) return;
    setError(null);

    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid email or password');
    } finally {
      endSubmit();
    }
  };

  const handleSSOLogin = async () => {
    try {
      const response = await getSSOLoginUrl();
      if (response.url) {
        window.location.href = response.url;
      } else {
        console.error('No URL in SSO response:', response);
        setError('SSO login URL not received');
      }
    } catch (err) {
      console.error('SSO login error:', err);
      setError('Failed to initiate SSO login');
    }
  };

  const logoSrc = isDarkTheme(theme) 
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <img
            src={logoSrc}
            alt="Milestone"
            className={styles.logo}
          />
          <p className={styles.subtitle}>Sign in to continue</p>
        </div>

        {ssoEnabled && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className={styles.fullWidth}
              onClick={handleSSOLogin}
              icon={
                <svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path fill="#f35325" d="M1 1h10v10H1z" />
                  <path fill="#81bc06" d="M12 1h10v10H12z" />
                  <path fill="#05a6f0" d="M1 12h10v10H1z" />
                  <path fill="#ffba08" d="M12 12h10v10H12z" />
                </svg>
              }
            >
              Sign in with Microsoft
            </Button>
            <div className={styles.divider}>
              <span>or sign in with email</span>
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            label="Email"
            type="email"
            id="email"
            fullWidth
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
            autoFocus
            disabled={isSubmitting}
          />

          <Input
            label="Password"
            type="password"
            id="password"
            fullWidth
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            disabled={isSubmitting}
          />

          {error && <div className={styles.error}>{error}</div>}

          <Button type="submit" size="lg" className={styles.fullWidth} loading={isSubmitting}>
            Sign In
          </Button>
        </form>
      </div>
    </div>
  );
}
