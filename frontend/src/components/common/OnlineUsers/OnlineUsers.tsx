/**
 * OnlineUsers Component
 * 
 * Shows avatars of currently online users in the header.
 * Non-intrusive indicator of who else is using the system.
 */

import { memo, useState } from 'react';
import { useWebSocketContext, PresenceUser } from '@/contexts/WebSocketContext';
import styles from './OnlineUsers.module.css';

/**
 * Get initials from name
 */
function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

/**
 * Get consistent color for user based on ID
 */
function getAvatarColor(userId: number): string {
  const colors = [
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#f97316', // orange
    '#10b981', // green
    '#06b6d4', // cyan
    '#f59e0b', // amber
    '#ef4444', // red
  ];
  return colors[userId % colors.length];
}

interface UserAvatarProps {
  user: PresenceUser;
  size?: 'small' | 'medium';
}

const UserAvatar = memo(function UserAvatar({ user, size = 'small' }: UserAvatarProps) {
  return (
    <div
      className={`${styles.avatar} ${styles[size]}`}
      style={{ backgroundColor: getAvatarColor(user.user_id) }}
      title={`${user.first_name} ${user.last_name}`}
    >
      {getInitials(user.first_name, user.last_name)}
    </div>
  );
});

export const OnlineUsers = memo(function OnlineUsers() {
  const { connectionState, onlineUsers, isConnected } = useWebSocketContext();
  const [showDropdown, setShowDropdown] = useState(false);

  // Don't show anything if not connected or no other users
  if (!isConnected && connectionState !== 'connecting') {
    return null;
  }

  const maxVisible = 3;
  const visibleUsers = onlineUsers.slice(0, maxVisible);
  const remainingCount = onlineUsers.length - maxVisible;

  return (
    <div 
      className={styles.container}
      onMouseEnter={() => setShowDropdown(true)}
      onMouseLeave={() => setShowDropdown(false)}
    >
      {/* Connection indicator */}
      <div className={`${styles.statusDot} ${styles[connectionState]}`} />
      
      {/* User avatars */}
      <div className={styles.avatars}>
        {visibleUsers.map((user) => (
          <UserAvatar key={user.user_id} user={user} />
        ))}
        {remainingCount > 0 && (
          <div className={styles.moreCount}>+{remainingCount}</div>
        )}
      </div>

      {/* Dropdown with full list */}
      {showDropdown && onlineUsers.length > 0 && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownHeader}>
            Online Users ({onlineUsers.length})
          </div>
          <div className={styles.dropdownList}>
            {onlineUsers.map((user) => (
              <div key={user.user_id} className={styles.dropdownItem}>
                <UserAvatar user={user} size="medium" />
                <span className={styles.userName}>
                  {user.first_name} {user.last_name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default OnlineUsers;
