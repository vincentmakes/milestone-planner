/**
 * ContextMenu
 * Right-click context menu for quick actions.
 *
 * A `role="menu"` of `menuitem`s. Dismissal (outside click, Tab out, Escape in
 * the capture phase, so only the menu closes) is the shared
 * `useDismissableOverlay`; every item click closes the menu too.
 */

import { useEffect, useRef } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled */
  title?: string;
  danger?: boolean;
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { onBlur } = useDismissableOverlay({ open: true, onClose, wrapperRef: menuRef });

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      if (x + rect.width > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 8;
      }

      if (y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 8;
      }

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: x, top: y }}
      role="menu"
      onBlur={onBlur}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={index} className={styles.divider} role="separator" />;
        }

        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''} ${item.disabled ? styles.disabled : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
            title={item.title}
          >
            {item.icon && <span className={styles.icon}>{item.icon}</span>}
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
