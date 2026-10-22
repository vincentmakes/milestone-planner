import { useEffect, useId, useRef, MutableRefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '@/stores/uiStore';
import styles from './Modal.module.css';
import { Icon, CloseIcon } from '@/components/common/Icon';

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

/** Drop the container this dialog registered from the open-dialog stack. */
function unregister(registeredRef: MutableRefObject<HTMLElement | null>): void {
  const registered = registeredRef.current;
  registeredRef.current = null;
  if (!registered) return;
  const i = openModals.indexOf(registered);
  if (i !== -1) openModals.splice(i, 1);
}

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
  // The container pushed onto `openModals`. modalRef is already null when the
  // close/unmount effects run (the dialog has left the DOM), so the entry is
  // removed through this ref — otherwise a closed child stays "innermost" and
  // its parent stops trapping Tab and answering Escape.
  const registeredRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const modalOpened = useUIStore((s) => s.modalOpened);
  const modalClosed = useUIStore((s) => s.modalClosed);

  // Store onClose in a ref to avoid re-running effect when it changes
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Handle escape key - use ref to avoid dependency on onClose
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    
    // Only the innermost open dialog closes, like the Tab trap below: a
    // confirmation over an edit dialog must not close both.
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const container = modalRef.current;
      if (!container || openModals[openModals.length - 1] !== container) return;
      onCloseRef.current();
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
      if (container) {
        openModals.push(container);
        registeredRef.current = container;
      }
      modalOpened();
      container?.focus();
      wasOpenRef.current = true;
    } else if (!isOpen && wasOpenRef.current) {
      // Modal just closed - restore scroll and the opener's focus
      document.body.style.overflow = '';
      unregister(registeredRef);
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
      unregister(registeredRef);
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
            <Icon icon={CloseIcon} size={18} />
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
