/**
 * Auth endpoints: the camelCase /auth/me payload is mapped to the snake_case
 * User model, and the SSO/auth probes degrade to "logged out / SSO off" on
 * network failure instead of throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import { checkAuth, checkSSOEnabled, fetchCurrentUser, getSSOLoginUrl, login, logout } from '../auth';

vi.mock('@/api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const get = vi.mocked(client.apiGet);
const post = vi.mocked(client.apiPost);

const apiUser = {
  id: 7,
  email: 'bob.brown@demo.local',
  firstName: 'Bob',
  lastName: 'Brown',
  name: 'Bob Brown',
  jobTitle: 'Scientist',
  role: 'superuser',
  maxCapacity: 80,
  siteIds: [1, 2],
  skills: [{ id: 1, name: 'HPLC' }],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('auth endpoints', () => {
  it('checkAuth maps the API user to the frontend model', async () => {
    get.mockResolvedValue({ user: apiUser });
    await expect(checkAuth()).resolves.toEqual({
      user: {
        id: 7,
        email: 'bob.brown@demo.local',
        first_name: 'Bob',
        last_name: 'Brown',
        name: 'Bob Brown',
        job_title: 'Scientist',
        role: 'superuser',
        max_capacity: 80,
        active: true,
        site_ids: [1, 2],
        skills: [{ id: 1, name: 'HPLC' }],
      },
    });
    expect(get).toHaveBeenCalledWith('/api/auth/me');
  });

  it('checkAuth returns no user when logged out or on error', async () => {
    get.mockResolvedValueOnce({ user: null });
    await expect(checkAuth()).resolves.toEqual({ user: null });
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(checkAuth()).resolves.toEqual({ user: null });
  });

  it('fetchCurrentUser defaults capacity, sites and skills', async () => {
    get.mockResolvedValueOnce({ user: { id: 1, max_capacity: 60 } });
    const user = await fetchCurrentUser();
    expect(user).toMatchObject({ id: 1, max_capacity: 60, site_ids: [], skills: [] });
    get.mockResolvedValueOnce({ user: { id: 2 } });
    expect((await fetchCurrentUser())?.max_capacity).toBe(100);
    get.mockResolvedValueOnce({ user: null });
    await expect(fetchCurrentUser()).resolves.toBeNull();
  });

  it('fetchCurrentUser propagates errors (unlike checkAuth)', async () => {
    get.mockRejectedValueOnce(new Error('500'));
    await expect(fetchCurrentUser()).rejects.toThrow('500');
  });

  it('login posts the credentials and maps the user; logout posts', async () => {
    post.mockResolvedValueOnce({ success: true, user: apiUser });
    const result = await login('bob.brown@demo.local', 'pw');
    expect(post).toHaveBeenCalledWith('/api/auth/login', { email: 'bob.brown@demo.local', password: 'pw' });
    expect(result.user.first_name).toBe('Bob');
    post.mockResolvedValueOnce({});
    await logout();
    expect(post).toHaveBeenLastCalledWith('/api/auth/logout');
  });

  it('checkSSOEnabled returns the status, or disabled on error', async () => {
    get.mockResolvedValueOnce({ enabled: true, provider: 'entra' });
    await expect(checkSSOEnabled()).resolves.toEqual({ enabled: true, provider: 'entra' });
    expect(get).toHaveBeenCalledWith('/api/auth/sso/status');
    get.mockRejectedValueOnce(new Error('x'));
    await expect(checkSSOEnabled()).resolves.toEqual({ enabled: false });
  });

  it('getSSOLoginUrl asks the backend for the authorization URL', async () => {
    get.mockResolvedValueOnce({ url: 'https://login.example/authorize' });
    await expect(getSSOLoginUrl()).resolves.toEqual({ url: 'https://login.example/authorize' });
    expect(get).toHaveBeenCalledWith('/api/auth/sso/login');
  });
});
