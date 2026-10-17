import { useState, useRef, useEffect } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useAuth } from '@/hooks/useAuth';
import { getAppVersion } from '@/api/endpoints/health';
import styles from './UserMenu.module.css';

export function UserMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentUser = useAppStore((s) => s.currentUser);
  const { logout } = useAuth();
  const openModal = useUIStore((s) => s.openModal);
  const [version, setVersion] = useState<string | null>(null);

  const { onBlur } = useDismissableOverlay({
    open: isOpen,
    onClose: () => setIsOpen(false),
    wrapperRef: menuRef,
    triggerRef,
  });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // The previous value stays on screen meanwhile, so reopening the menu does
    // not flash a placeholder.
    getAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // useAuth().logout destroys the session and resets every store (including
  // isAuthenticated), so App swaps to the login screen in place, the same path
  // a revoked session takes. No reload needed: the WebSocket closes when
  // WebSocketProvider unmounts, and persisted view preferences survive by design.
  const handleLogout = async () => {
    setIsOpen(false);
    await logout();
  };

  if (!currentUser) return null;

  const initials = `${currentUser.first_name?.[0] || ''}${currentUser.last_name?.[0] || ''}`.toUpperCase() || '?';

  return (
    <div ref={menuRef} className={styles.wrapper} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label="Account menu"
      >
        <span className={styles.avatar} aria-hidden="true">{initials}</span>
        <svg
          className={`${styles.chevron} ${isOpen ? styles.open : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.menu}>
          <div className={styles.userInfo}>
            <span className={styles.name}>{currentUser.name}</span>
            <span className={styles.email}>{currentUser.email}</span>
            <span className={styles.role}>{currentUser.role}</span>
          </div>
          <div className={styles.divider} />
          <button
            className={styles.menuItem}
            onClick={() => {
              setIsOpen(false);
              openModal('myAbsences');
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>My absences</span>
          </button>
          <button className={styles.menuItem} onClick={handleLogout}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Log out</span>
          </button>
          {/* Omitted entirely when the server could not be reached — better a
              menu without a version than one showing a dash. */}
          {version && (
            <>
              <div className={styles.divider} />
              <div className={styles.version}>v{version}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
