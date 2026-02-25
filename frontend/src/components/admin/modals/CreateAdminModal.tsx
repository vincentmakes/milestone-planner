/**
 * CreateAdminModal
 * Modal for creating a new admin user
 */

import { useState, FormEvent } from 'react';
import { createAdminUser } from '@/api';
import styles from './AdminModal.module.css';

interface CreateAdminModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateAdminModal({ onClose, onCreated }: CreateAdminModalProps) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    role: 'admin',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await createAdminUser(formData);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create admin user');
    } finally {
      setIsSubmitting(false);
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
          <h2 className={styles.title}>Create Admin User</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form id="create-admin-form" onSubmit={handleSubmit} className={styles.body}>
            <div className={styles.form}>
              <div className={styles.formGroup}>
                <label className={styles.label}>Email *</label>
                <input
                  type="email"
                  name="email"
                  className={styles.input}
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="admin@example.com"
                  required
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Password *</label>
                <input
                  type="password"
                  name="password"
                  className={styles.input}
                  value={formData.password}
                  onChange={handleChange}
                  placeholder="••••••••"
                  minLength={8}
                  required
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Name *</label>
                <input
                  type="text"
                  name="name"
                  className={styles.input}
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="John Doe"
                  required
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Role</label>
                <select
                  name="role"
                  className={styles.select}
                  value={formData.role}
                  onChange={handleChange}
                  disabled={isSubmitting}
                >
                  <option value="admin">Admin</option>
                  <option value="superadmin">Superadmin</option>
                </select>
              </div>

              {error && <div className={styles.error}>{error}</div>}
            </div>
        </form>

        <div className={styles.footer}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-admin-form"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create Admin'}
          </button>
        </div>
      </div>
    </div>
  );
}
