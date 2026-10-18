/**
 * ProvisionTenantModal
 * Asks how to provision a tenant's database: bare defaults, or the demo data
 * set. The caller runs the API call with the chosen options.
 */

import { useId, useState } from 'react';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import type { TenantProvisionOptions } from '@/api/endpoints/admin';
import { useEscapeKey } from '@/hooks';
import styles from './AdminModal.module.css';

export const SEED_DEMO_LABEL = 'Seed demo data';
export const SEED_DEMO_HINT =
  'Fills the new database with the sample company: two sites, nine people, four projects ' +
  'with bookings, absences, holidays, tags, Kanban comments and notifications. ' +
  'Sample people sign in with the password demo1234; the admin keeps the password shown ' +
  'after provisioning.';

interface ProvisionTenantModalProps {
  tenantName: string;
  onClose: () => void;
  onConfirm: (options: TenantProvisionOptions) => void;
}

export function ProvisionTenantModal({ tenantName, onClose, onConfirm }: ProvisionTenantModalProps) {
  const [seedDemoData, setSeedDemoData] = useState(false);
  const titleId = useId();
  useEscapeKey(onClose);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>Provision database</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.form}>
            <p className={styles.intro}>
              This creates the database for <strong>{tenantName}</strong>, applies the schema and
              creates the admin account. The admin password is shown once afterwards.
            </p>
            <div className={styles.formGroup}>
              <ToggleSwitch checked={seedDemoData} onChange={setSeedDemoData} label={SEED_DEMO_LABEL} />
              <span className={styles.hint}>{SEED_DEMO_HINT}</span>
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button type="button" className={`${styles.btn} ${styles.btnSecondary}`} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => onConfirm({ seedDemoData })}
          >
            Provision
          </button>
        </div>
      </div>
    </div>
  );
}
