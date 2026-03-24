/**
 * AdminApp
 * Main Admin application component
 */

import { useEffect } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { getAdminMe } from '@/api';
import { AdminLoginScreen } from './AdminLoginScreen';
import { AdminDashboard } from './AdminDashboard';

export function AdminApp() {
  const isAuthenticated = useAdminStore((s) => s.isAuthenticated);
  const isLoading = useAdminStore((s) => s.isLoading);
  const setAdminUser = useAdminStore((s) => s.setAdminUser);
  const setIsAuthenticated = useAdminStore((s) => s.setIsAuthenticated);
  const setIsLoading = useAdminStore((s) => s.setIsLoading);

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await getAdminMe();
        if (response.user) {
          setAdminUser(response.user);
          setIsAuthenticated(true);
        }
      } catch (err) {
        // Not authenticated
        // Not authenticated - no action needed
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, [setAdminUser, setIsAuthenticated, setIsLoading]);

  // Show loading state
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-muted)',
      }}>
        Loading...
      </div>
    );
  }

  // Show login or dashboard
  return isAuthenticated ? <AdminDashboard /> : <AdminLoginScreen />;
}
