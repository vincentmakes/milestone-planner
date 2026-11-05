/**
 * The audit log's chips: outlined for a category and an origin, filled for an
 * outcome. Tones are tokens (`--status-info`, `--status-warning`,
 * `--accent-purple`, `--text-secondary`, `--status-success`,
 * `--status-error`), set as the chip's `--chip-color`.
 */

import type { ReactNode } from 'react';
import type { AuditChipTone } from './auditDetails';
import styles from './AuditLogPanel.module.css';

const TONE_CLASS: Record<AuditChipTone, string> = {
  info: styles.toneInfo,
  warning: styles.toneWarning,
  accent: styles.toneAccent,
  neutral: styles.toneNeutral,
  success: styles.toneSuccess,
  error: styles.toneError,
};

export interface AuditChipProps {
  tone: AuditChipTone;
  variant: 'outlined' | 'filled';
  children: ReactNode;
  title?: string;
}

export function AuditChip({ tone, variant, children, title }: AuditChipProps) {
  return (
    <span className={`${styles.chip} ${styles[variant]} ${TONE_CLASS[tone]}`} title={title}>
      {children}
    </span>
  );
}
