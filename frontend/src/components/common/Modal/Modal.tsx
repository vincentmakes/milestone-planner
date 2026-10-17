import { useEffect, useId, useRef, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '@/stores/uiStore';
import styles from './Modal.module.css';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 'wide' is a large centered workspace (capped at 1360×900) for the Settings hub */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'wide';
  footer?: ReactNode;
  closeOnEscape?: boolean;
  /** Drop the body padding and scrolling so the content can lay out its own panes */
  flushBody?: boolean;
}

/**
 * The open dialogs, innermost last. Only the innermost traps Tab: a child
 * dialog is portaled to <body>, outside its parent's container, so the parent
 * must not pull focus back while the child is open.
 */
const openModals: HTMLElement[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  );
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  footer,
  closeOnEscape = true,
  flushBody = false,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const modalOpened = useUIStore((s) => s.modalOpened);
  const modalClosed = useUIStore((s) => s.modalClosed);

  // Store onClose in a ref to avoid re-running effect when it changes
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Handle escape key - use ref to avoid dependency on onClose
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeOnEscape]);

  // Keep Tab inside the innermost open dialog (a modal owns the keyboard).
  useEffect(() => {
    if (!isOpen) return;
    const handleTab = (e: KeyboardEvent) => {
      const container = modalRef.current;
      if (e.key !== 'Tab' || !container || openModals[openModals.length - 1] !== container) return;
      const items = focusables(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && container.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first || active === container) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last || active === container) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleTab, true);
    return () => document.removeEventListener('keydown', handleTab, true);
  }, [isOpen]);

  // Body scroll lock, open-modal registry, initial focus and focus restore —
  // only on the open/close transitions.
  useEffect(() => {
    const container = modalRef.current;
    if (isOpen && !wasOpenRef.current) {
      // Modal just opened - remember the opener, focus the dialog, lock scroll
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.body.style.overflow = 'hidden';
      if (container) openModals.push(container);
      modalOpened();
      container?.focus();
      wasOpenRef.current = true;
    } else if (!isOpen && wasOpenRef.current) {
      // Modal just closed - restore scroll and the opener's focus
      document.body.style.overflow = '';
      if (container) {
        const i = openModals.indexOf(container);
        if (i !== -1) openModals.splice(i, 1);
      }
      modalClosed();
      wasOpenRef.current = false;
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected) opener.focus();
    }
  }, [isOpen, modalOpened, modalClosed]);

  // Unmounting while open (the parent rendered `null`) closes it the same way.
  useEffect(() => {
    return () => {
      if (!wasOpenRef.current) return;
      document.body.style.overflow = '';
      const container = modalRef.current;
      if (container) {
        const i = openModals.indexOf(container);
        if (i !== -1) openModals.splice(i, 1);
      }
      useUIStore.getState().modalClosed();
      wasOpenRef.current = false;
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  if (!isOpen) return null;

  const modalClasses = [styles.modal, styles[size]].join(' ');

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div ref={modalRef} className={modalClasses} tabIndex={-1}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={flushBody ? `${styles.body} ${styles.bodyFlush}` : styles.body}>
          {children}
        </div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
