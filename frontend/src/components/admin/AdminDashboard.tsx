/**
 * Admin Dashboard
 * Main dashboard for multi-tenant management
 */

import { useEffect, useState } from 'react';
import { useAdminStore } from '@/stores/adminStore';
import { 
  adminLogout, 
  getTenants, 
  getSystemStats, 
  getAdminUsers,
  getOrganizations,
} from '@/api';
import { getTheme, isDarkTheme, type Theme } from '@/utils/storage';
import { Button } from '@/components/common/Button';
import { Icon, LogoutIcon, BarChartIcon, UsersIcon, GlobeIcon, BuildingIcon } from '@/components/common/Icon';
import { TenantList } from './TenantList';
import { OrganizationList } from './OrganizationList';
import { AdminUserList } from './AdminUserList';
import { SystemStatsPanel } from './SystemStatsPanel';
import { CreateTenantModal } from './modals/CreateTenantModal';
import { CreateAdminModal } from './modals/CreateAdminModal';
import { CreateOrganizationModal } from './modals/CreateOrganizationModal';
import { TenantDetailsModal } from './modals/TenantDetailsModal';
import { OrganizationDetailsModal } from './modals/OrganizationDetailsModal';
import { CredentialsModal } from './modals/CredentialsModal';
import styles from './AdminDashboard.module.css';

export function AdminDashboard() {
  const adminUser = useAdminStore((s) => s.adminUser);
  const activeTab = useAdminStore((s) => s.activeTab);
  const setActiveTab = useAdminStore((s) => s.setActiveTab);
  const setTenants = useAdminStore((s) => s.setTenants);
  const setOrganizations = useAdminStore((s) => s.setOrganizations);
  const setSystemStats = useAdminStore((s) => s.setSystemStats);
  const setAdminUsers = useAdminStore((s) => s.setAdminUsers);
  const setIsAuthenticated = useAdminStore((s) => s.setIsAuthenticated);
  const setAdminUser = useAdminStore((s) => s.setAdminUser);
  const reset = useAdminStore((s) => s.reset);
  
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [showCreateOrganization, setShowCreateOrganization] = useState(false);
  const [showCreateAdmin, setShowCreateAdmin] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{ title: string; email: string; password: string } | null>(null);

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

  // Load initial data
  useEffect(() => {
    loadTenants();
    loadOrganizations();
    loadStats();
  }, []);

  // Load admin users when switching to admins tab
  useEffect(() => {
    if (activeTab === 'admins') {
      loadAdminUsers();
    }
  }, [activeTab]);

  const loadTenants = async () => {
    try {
      const data = await getTenants();
      setTenants(data);
    } catch (err) {
      console.error('Failed to load tenants:', err);
    }
  };

  const loadOrganizations = async () => {
    try {
      const data = await getOrganizations();
      setOrganizations(data);
    } catch (err) {
      console.error('Failed to load organizations:', err);
    }
  };

  const loadStats = async () => {
    try {
      const data = await getSystemStats();
      setSystemStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const loadAdminUsers = async () => {
    try {
      const data = await getAdminUsers();
      setAdminUsers(data);
    } catch (err) {
      console.error('Failed to load admin users:', err);
    }
  };

  const handleLogout = async () => {
    try {
      await adminLogout();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      reset();
      setIsAuthenticated(false);
      setAdminUser(null);
    }
  };

  const handleShowCredentials = (title: string, email: string, password: string) => {
    setCredentials({ title, email, password });
  };

  const logoSrc = isDarkTheme(theme)
    ? '/img/milestone_logo_dark_theme.svg'
    : '/img/milestone_logo_light_theme.svg';

  const isSuperadmin = adminUser?.role === 'superadmin';

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <img src={logoSrc} alt="Milestone" className={styles.logo} />
          <h1 className={styles.title}>Admin Portal</h1>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.userInfo}>
            {adminUser?.email}
            {adminUser?.role === 'superadmin' && (
              <span className={styles.roleBadge}>Superadmin</span>
            )}
          </span>
          <Button variant="ghost" icon={<Icon icon={LogoutIcon} />} onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'tenants' ? styles.active : ''}`}
          onClick={() => setActiveTab('tenants')}
        >
          <Icon icon={BuildingIcon} size={18} />
          Tenants
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'organizations' ? styles.active : ''}`}
          onClick={() => setActiveTab('organizations')}
        >
          <Icon icon={GlobeIcon} size={18} />
          Organizations
        </button>
        {isSuperadmin && (
          <button
            className={`${styles.tab} ${activeTab === 'admins' ? styles.active : ''}`}
            onClick={() => setActiveTab('admins')}
          >
            <Icon icon={UsersIcon} size={18} />
            Admin Users
          </button>
        )}
        <button
          className={`${styles.tab} ${activeTab === 'stats' ? styles.active : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          <Icon icon={BarChartIcon} size={18} />
          System Stats
        </button>
      </nav>

      {/* Main Content */}
      <main className={styles.main}>
        {activeTab === 'tenants' && (
          <TenantList
            onCreateNew={() => setShowCreateTenant(true)}
            onViewDetails={(id) => setSelectedTenantId(id)}
            onShowCredentials={handleShowCredentials}
            onRefresh={loadTenants}
          />
        )}
        {activeTab === 'organizations' && (
          <OrganizationList
            onCreateNew={() => setShowCreateOrganization(true)}
            onViewDetails={(id) => setSelectedOrganizationId(id)}
            onRefresh={loadOrganizations}
          />
        )}
        {activeTab === 'admins' && isSuperadmin && (
          <AdminUserList
            onCreateNew={() => setShowCreateAdmin(true)}
            onRefresh={loadAdminUsers}
          />
        )}
        {activeTab === 'stats' && (
          <SystemStatsPanel onRefresh={loadStats} />
        )}
      </main>

      {/* Modals */}
      {showCreateTenant && (
        <CreateTenantModal
          onClose={() => setShowCreateTenant(false)}
          onCreated={() => {
            loadTenants();
            setShowCreateTenant(false);
          }}
          onShowCredentials={handleShowCredentials}
        />
      )}

      {showCreateOrganization && (
        <CreateOrganizationModal
          onClose={() => setShowCreateOrganization(false)}
          onCreated={() => {
            loadOrganizations();
            setShowCreateOrganization(false);
          }}
        />
      )}

      {showCreateAdmin && (
        <CreateAdminModal
          onClose={() => setShowCreateAdmin(false)}
          onCreated={() => {
            loadAdminUsers();
            setShowCreateAdmin(false);
          }}
        />
      )}

      {selectedTenantId && (
        <TenantDetailsModal
          tenantId={selectedTenantId}
          onClose={() => setSelectedTenantId(null)}
          onShowCredentials={handleShowCredentials}
          onRefresh={loadTenants}
        />
      )}

      {selectedOrganizationId && (
        <OrganizationDetailsModal
          organizationId={selectedOrganizationId}
          onClose={() => setSelectedOrganizationId(null)}
          onRefresh={() => {
            loadOrganizations();
            loadTenants();
          }}
        />
      )}

      {credentials && (
        <CredentialsModal
          title={credentials.title}
          email={credentials.email}
          password={credentials.password}
          onClose={() => setCredentials(null)}
        />
      )}
    </div>
  );
}
