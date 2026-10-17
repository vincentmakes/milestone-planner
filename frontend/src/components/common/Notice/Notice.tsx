/**
 * Notice — the one inline message box (UI_GUIDELINES §3, "Errors and
 * messages"). Errors, warnings and information show in place, next to what
 * they are about, never as a browser `alert()`.
 *
 * `tone` picks the colour (accent token on its alpha background); `role`
 * defaults to `alert` for errors (announced at once) and `status` for the
 * rest (announced politely). An `onDismiss` adds a labelled close button.
 */

import type { CSSProperties, ReactNode } from 'react';
import styles from './Notice.module.css';

export type NoticeTone = 'error' | 'warning' | 'info' | 'success';

export interface NoticeProps {
  tone?: NoticeTone;
  role?: 'alert' | 'status';
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function Notice({ tone = 'error', role, children, onDismiss, className, style }: NoticeProps) {
  const classes = [styles.notice, styles[tone], className].filter(Boolean).join(' ');
  return (
    <div className={classes} role={role ?? (tone === 'error' ? 'alert' : 'status')} style={style}>
      <div className={styles.body}>{children}</div>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
