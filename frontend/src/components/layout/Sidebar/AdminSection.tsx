import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import styles from './AdminSection.module.css';

interface AdminItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  modal: string;
  adminOnly?: boolean;
}

interface AdminSectionProps {
  collapsed?: boolean;
}

const ADMIN_ITEMS: AdminItem[] = [
  {
    id: 'users',
    label: 'Manage Users',
    modal: 'userManagement',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
    ),
  },
  {
    id: 'equipment',
    label: 'Manage Equipment',
    modal: 'manageEquipment',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      </svg>
    ),
  },
  {
    id: 'sites',
    label: 'Manage Sites',
    modal: 'manageSites',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
  {
    id: 'phases',
    label: 'Predefined Phases',
    modal: 'predefinedPhases',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    ),
  },
  {
    id: 'sso',
    label: 'SSO Configuration',
    modal: 'ssoConfig',
    adminOnly: true,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    modal: 'settings',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
];

export function AdminSection({ collapsed = false }: AdminSectionProps) {
  const setActiveModal = useUIStore((s) => s.setActiveModal);
  const currentUser = useAppStore((s) => s.currentUser);
  
  const isAdmin = currentUser?.role === 'admin';

  const handleClick = (modal: string) => {
    setActiveModal(modal);
  };
  
  // Filter items based on user role
  const visibleItems = ADMIN_ITEMS.filter(item => !item.adminOnly || isAdmin);

  return (
    <div className={`${styles.section} ${collapsed ? styles.collapsed : ''}`}>
      {visibleItems.map((item) => (
        <button
          key={item.id}
          className={styles.item}
          onClick={() => handleClick(item.modal)}
          title={collapsed ? item.label : undefined}
        >
          <span className={styles.icon}>{item.icon}</span>
          {!collapsed && <span className={styles.label}>{item.label}</span>}
        </button>
      ))}
    </div>
  );
}
