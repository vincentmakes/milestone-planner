/**
 * CreateAdminModal
 * Modal for creating a new admin user
 */

import { useId, useState, FormEvent } from 'react';
import { Notice } from '@/components/common/Notice';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { createAdminUser } from '@/api';
import { useEscapeKey } from '@/hooks';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import styles from './AdminModal.module.css';
import { Icon, CloseIcon } from '@/components/common/Icon';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'superadmin', label: 'Superadmin' },
];

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
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
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
    if (!beginSubmit()) return;
    setError(null);

    try {
      await createAdminUser(formData);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create admin user');
    } finally {
      endSubmit();
    }
  };

  const titleId = useId();
  useEscapeKey(onClose);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>Create Admin User</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <Icon icon={CloseIcon} size={20} />
          </button>
        </div>

        <form id="create-admin-form" onSubmit={handleSubmit} className={styles.body}>
            <div className={styles.form}>
              <Input
                label="Email *"
                type="email"
                name="email"
                fullWidth
                value={formData.email}
                onChange={handleChange}
                placeholder="admin@example.com"
                required
                disabled={isSubmitting}
              />

              <Input
                label="Password *"
                type="password"
                name="password"
                fullWidth
                value={formData.password}
                onChange={handleChange}
                placeholder="••••••••"
                minLength={8}
                required
                disabled={isSubmitting}
              />

              <Input
                label="Name *"
                type="text"
                name="name"
                fullWidth
                value={formData.name}
                onChange={handleChange}
                placeholder="John Doe"
                required
                disabled={isSubmitting}
              />

              <Select
                label="Role"
                name="role"
                fullWidth
                value={formData.role}
                onChange={handleChange}
                disabled={isSubmitting}
                options={ROLE_OPTIONS}
              />

              {error && <Notice tone="error">{error}</Notice>}
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
