/**
 * CreateTenantModal
 * Modal for creating a new tenant
 */

import { useState, FormEvent } from 'react';
import { createTenant } from '@/api';
import type { Tenant, TenantCreateRequest } from '@/api/endpoints/admin';
import styles from './AdminModal.module.css';

interface CreateTenantModalProps {
  onClose: () => void;
  onCreated: (tenant: Tenant) => void;
}

export function CreateTenantModal({ onClose, onCreated }: CreateTenantModalProps) {
  const [formData, setFormData] = useState<TenantCreateRequest>({
    name: '',
    slug: '',
    company_name: '',
    admin_email: '',
    plan: 'standard',
    max_users: 10,
    max_projects: 50,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'number' ? parseInt(value, 10) : value,
    }));
  };

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    setFormData((prev) => ({
      ...prev,
      name,
      slug,
    }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const tenant = await createTenant(formData);
      onCreated(tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
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
          <h2 className={styles.title}>Create Tenant</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.body}>
            <div className={styles.form}>
              <div className={styles.formGroup}>
                <label className={styles.label}>Tenant Name *</label>
                <input
                  type="text"
                  name="name"
                  className={styles.input}
                  value={formData.name}
                  onChange={handleNameChange}
                  placeholder="Acme Corporation"
                  required
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>URL Slug *</label>
                <input
                  type="text"
                  name="slug"
                  className={styles.input}
                  value={formData.slug}
                  onChange={handleChange}
                  placeholder="acme-corp"
                  pattern="[a-z0-9-]+"
                  required
                  disabled={isSubmitting}
                />
                <small style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  Access URL: /t/{formData.slug || 'slug'}/
                </small>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Company Name</label>
                <input
                  type="text"
                  name="company_name"
                  className={styles.input}
                  value={formData.company_name}
                  onChange={handleChange}
                  placeholder="Acme Corporation Inc."
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Admin Email *</label>
                <input
                  type="email"
                  name="admin_email"
                  className={styles.input}
                  value={formData.admin_email}
                  onChange={handleChange}
                  placeholder="admin@acme.com"
                  required
                  disabled={isSubmitting}
                />
              </div>

              <div className={styles.formRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>Plan</label>
                  <select
                    name="plan"
                    className={styles.select}
                    value={formData.plan}
                    onChange={handleChange}
                    disabled={isSubmitting}
                  >
                    <option value="trial">Trial</option>
                    <option value="standard">Standard</option>
                    <option value="professional">Professional</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>Max Users</label>
                  <input
                    type="number"
                    name="max_users"
                    className={styles.input}
                    value={formData.max_users}
                    onChange={handleChange}
                    min="1"
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>Max Projects</label>
                <input
                  type="number"
                  name="max_projects"
                  className={styles.input}
                  value={formData.max_projects}
                  onChange={handleChange}
                  min="1"
                  disabled={isSubmitting}
                />
              </div>

              {error && <div className={styles.error}>{error}</div>}
            </div>
          </div>

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
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create Tenant'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
