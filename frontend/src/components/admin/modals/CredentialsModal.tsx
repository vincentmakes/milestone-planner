/**
 * CredentialsModal
 * Modal showing credentials after provisioning or password reset
 */

import { useState } from 'react';
import styles from './AdminModal.module.css';

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

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
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
