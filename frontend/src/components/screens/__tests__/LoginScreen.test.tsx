/**
 * Login screen: email/password submit through useAuth().login, the error
 * shown on failure, the Microsoft SSO button driven by /auth/sso/status, the
 * SSO redirect, and the ?sso_error= message from a failed SSO round-trip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from '../LoginScreen';
import { checkSSOEnabled, getSSOLoginUrl } from '@/api';

const login = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ login }) }));
vi.mock('@/api', () => ({ checkSSOEnabled: vi.fn(), getSSOLoginUrl: vi.fn() }));

beforeEach(() => {
  login.mockReset().mockResolvedValue(undefined);
  vi.mocked(checkSSOEnabled).mockReset().mockResolvedValue({ enabled: false });
  vi.mocked(getSSOLoginUrl).mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState({}, '', '/t/demo/');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const signIn = () => act(async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
});

async function fillAndSubmit(email = 'bob.brown@demo.local', password = 'demo1234') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  await signIn();
}

describe('LoginScreen', () => {
  it('submits the credentials to login()', async () => {
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(login).toHaveBeenCalledWith('bob.brown@demo.local', 'demo1234');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables the form while signing in', async () => {
    let finish: () => void = () => {};
    login.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
  });

  it('shows the server error message, or a generic one', async () => {
    login.mockRejectedValueOnce(new Error('Account disabled'));
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(await screen.findByText('Account disabled')).toBeInTheDocument();

    login.mockRejectedValueOnce('nope');
    await signIn();
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
  });

  it('hides the SSO button when SSO is off or the status call fails', async () => {
    vi.mocked(checkSSOEnabled).mockRejectedValueOnce(new Error('down'));
    render(<LoginScreen />);
    await waitFor(() => expect(checkSSOEnabled).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Sign in with Microsoft/ })).not.toBeInTheDocument();
  });

  it('redirects to the Entra URL from the SSO button', async () => {
    vi.mocked(checkSSOEnabled).mockResolvedValue({ enabled: true });
    vi.mocked(getSSOLoginUrl).mockResolvedValue({ url: '#sso-redirect' });
    render(<LoginScreen />);
    const button = await screen.findByRole('button', { name: /Sign in with Microsoft/ });
    expect(screen.getByText('or sign in with email')).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(window.location.hash).toBe('#sso-redirect'));
  });

  it('reports a missing or failing SSO login URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkSSOEnabled).mockResolvedValue({ enabled: true });
    vi.mocked(getSSOLoginUrl).mockResolvedValueOnce({ url: '' });
    render(<LoginScreen />);
    const button = await screen.findByRole('button', { name: /Sign in with Microsoft/ });
    fireEvent.click(button);
    expect(await screen.findByText('SSO login URL not received')).toBeInTheDocument();

    vi.mocked(getSSOLoginUrl).mockRejectedValueOnce(new Error('500'));
    fireEvent.click(button);
    expect(await screen.findByText('Failed to initiate SSO login')).toBeInTheDocument();
  });

  it('shows ?sso_error= once and strips it from the URL, keeping other params', () => {
    window.history.replaceState({}, '', '/t/demo/?sso_error=Not%20in%20group&x=1#top');
    render(<LoginScreen />);
    expect(screen.getByText('Not in group')).toBeInTheDocument();
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#top');
  });

  it('strips the query string entirely when sso_error was the only param', () => {
    window.history.replaceState({}, '', '/t/demo/?sso_error=Denied');
    render(<LoginScreen />);
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('picks the logo for the theme and follows theme changes', async () => {
    localStorage.setItem('milestone_theme', 'light');
    render(<LoginScreen />);
    const logo = screen.getByAltText('Milestone');
    expect(logo).toHaveAttribute('src', '/img/milestone_logo_light_theme.svg');
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 's-theme-dark');
    });
    await waitFor(() => expect(logo).toHaveAttribute('src', '/img/milestone_logo_dark_theme.svg'));
  });
});
