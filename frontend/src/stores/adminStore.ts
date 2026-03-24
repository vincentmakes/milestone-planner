/**
 * Admin Store
 * State management for multi-tenant admin panel
 */

import { create } from 'zustand';
import type { AdminUser, Tenant, SystemStats, AdminUserListItem, Organization } from '@/api/endpoints/admin';

interface AdminState {
  // Auth
  adminUser: AdminUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  mustChangePassword: boolean;
  
  // Data
  tenants: Tenant[];
  organizations: Organization[];
  systemStats: SystemStats | null;
  adminUsers: AdminUserListItem[];
  
  // UI
  activeTab: 'tenants' | 'organizations' | 'admins' | 'stats';
  selectedTenantId: string | null;
  selectedOrganizationId: string | null;
  
  // Actions
  setAdminUser: (user: AdminUser | null) => void;
  setIsAuthenticated: (auth: boolean) => void;
  setIsLoading: (loading: boolean) => void;
  setMustChangePassword: (must: boolean) => void;
  setTenants: (tenants: Tenant[]) => void;
  setOrganizations: (organizations: Organization[]) => void;
  setSystemStats: (stats: SystemStats | null) => void;
  setAdminUsers: (users: AdminUserListItem[]) => void;
  setActiveTab: (tab: 'tenants' | 'organizations' | 'admins' | 'stats') => void;
  setSelectedTenantId: (id: string | null) => void;
  setSelectedOrganizationId: (id: string | null) => void;
  
  // Tenant helpers
  updateTenantInList: (id: string, updates: Partial<Tenant>) => void;
  removeTenantFromList: (id: string) => void;
  addTenantToList: (tenant: Tenant) => void;
  
  // Organization helpers
  updateOrganizationInList: (id: string, updates: Partial<Organization>) => void;
  removeOrganizationFromList: (id: string) => void;
  addOrganizationToList: (organization: Organization) => void;
  
  // Admin user helpers
  updateAdminUserInList: (id: number, updates: Partial<AdminUserListItem>) => void;
  removeAdminUserFromList: (id: number) => void;
  addAdminUserToList: (user: AdminUserListItem) => void;
  
  // Reset
  reset: () => void;
}

const initialState = {
  adminUser: null,
  isAuthenticated: false,
  isLoading: true,
  mustChangePassword: false,
  tenants: [],
  organizations: [],
  systemStats: null,
  adminUsers: [],
  activeTab: 'tenants' as const,
  selectedTenantId: null,
  selectedOrganizationId: null,
};

export const useAdminStore = create<AdminState>((set) => ({
  ...initialState,
  
  setAdminUser: (user) => set({ adminUser: user }),
  setIsAuthenticated: (auth) => set({ isAuthenticated: auth }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setMustChangePassword: (must) => set({ mustChangePassword: must }),
  setTenants: (tenants) => set({ tenants }),
  setOrganizations: (organizations) => set({ organizations }),
  setSystemStats: (stats) => set({ systemStats: stats }),
  setAdminUsers: (users) => set({ adminUsers: users }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedTenantId: (id) => set({ selectedTenantId: id }),
  setSelectedOrganizationId: (id) => set({ selectedOrganizationId: id }),
  
  updateTenantInList: (id, updates) => set((state) => ({
    tenants: state.tenants.map((t) => 
      t.id === id ? { ...t, ...updates } : t
    ),
  })),
  
  removeTenantFromList: (id) => set((state) => ({
    tenants: state.tenants.filter((t) => t.id !== id),
  })),
  
  addTenantToList: (tenant) => set((state) => ({
    tenants: [tenant, ...state.tenants],
  })),
  
  updateOrganizationInList: (id, updates) => set((state) => ({
    organizations: state.organizations.map((o) =>
      o.id === id ? { ...o, ...updates } : o
    ),
  })),
  
  removeOrganizationFromList: (id) => set((state) => ({
    organizations: state.organizations.filter((o) => o.id !== id),
  })),
  
  addOrganizationToList: (organization) => set((state) => ({
    organizations: [organization, ...state.organizations],
  })),
  
  updateAdminUserInList: (id, updates) => set((state) => ({
    adminUsers: state.adminUsers.map((u) =>
      u.id === id ? { ...u, ...updates } : u
    ),
  })),
  
  removeAdminUserFromList: (id) => set((state) => ({
    adminUsers: state.adminUsers.filter((u) => u.id !== id),
  })),
  
  addAdminUserToList: (user) => set((state) => ({
    adminUsers: [user, ...state.adminUsers],
  })),
  
  reset: () => set(initialState),
}));
