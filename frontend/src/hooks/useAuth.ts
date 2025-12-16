/**
 * useAuth Hook
 * Manages authentication state and operations
 */

import { useEffect, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { checkAuth, login as apiLogin, logout as apiLogout } from '@/api';
import type { User } from '@/types';

interface UseAuthReturn {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const currentUser = useAppStore((s) => s.currentUser);
  const isAuthChecking = useAppStore((s) => s.isAuthChecking);
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const setCurrentUser = useAppStore((s) => s.setCurrentUser);
  const setAuthChecking = useAppStore((s) => s.setAuthChecking);
  const setAuthenticated = useAppStore((s) => s.setAuthenticated);
  const reset = useAppStore((s) => s.reset);

  // Check authentication status on mount
  useEffect(() => {
    const checkAuthentication = async () => {
      try {
        const response = await checkAuth();
        if (response.user) {
          setCurrentUser(response.user);
          setAuthenticated(true);
        } else {
          setAuthenticated(false);
        }
      } catch (err) {
        console.error('Auth check failed:', err);
        setAuthenticated(false);
      } finally {
        setAuthChecking(false);
      }
    };

    // Only check if we haven't finished checking yet
    if (isAuthChecking) {
      checkAuthentication();
    }
  }, [isAuthChecking, setCurrentUser, setAuthenticated, setAuthChecking]);

  // Login function
  const login = useCallback(async (email: string, password: string) => {
    try {
      const response = await apiLogin(email, password);
      setCurrentUser(response.user);
      setAuthenticated(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      throw new Error(message);
    }
  }, [setCurrentUser, setAuthenticated]);

  // Logout function
  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setCurrentUser(null);
      setAuthenticated(false);
      reset();
    }
  }, [setCurrentUser, setAuthenticated, reset]);

  return {
    isLoading: isAuthChecking,
    isAuthenticated,
    user: currentUser,
    login,
    logout,
  };
}
