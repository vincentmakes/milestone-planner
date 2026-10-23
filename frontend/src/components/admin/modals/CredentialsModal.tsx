/**
 * CredentialsModal
 * Modal showing credentials after provisioning or password reset
 */

import { useId, useState } from 'react';
import { useEscapeKey } from '@/hooks';
import styles from './AdminModal.module.css';
import { Icon, CloseIcon } from '@/components/common/Icon';

interface CredentialsModalProps {
  title: string;
  email: string;
  password: string;
  onClose: () => void;
}

export function CredentialsModal({ title, email, password, onClose }: CredentialsModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = `Email: ${email}\nPassword: ${password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const titleId = useId();
  useEscapeKey(onClose);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <Icon icon={CloseIcon} size={20} />
          </button>
        </div>

        <div className={styles.body}>
          <p style={{ marginBottom: '1.5rem', color: 'var(--text-secondary)' }}>
            Please save these credentials securely. The password will not be shown again.
          </p>

          <div className={styles.form}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Email</label>
              <div className={styles.credentialsField}>
                <input
                  type="text"
                  className={styles.credentialsInput}
                  value={email}
                  readOnly
                />
              </div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label}>Password</label>
              <div className={styles.credentialsField}>
                <input
                  type="text"
                  className={styles.credentialsInput}
                  value={password}
                  readOnly
                />
              </div>
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={onClose}
          >
            Close
          </button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleCopy}
          >
            {copied ? 'Copied!' : 'Copy Credentials'}
          </button>
        </div>
      </div>
    </div>
  );
}
