/**
 * CreateTenantModal
 * Modal for creating a new tenant
 */

import { useId, useState, FormEvent } from 'react';
import { Notice } from '@/components/common/Notice';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { createTenant } from '@/api';
import type { Tenant, TenantCreateRequest } from '@/api/endpoints/admin';
import { useEscapeKey } from '@/hooks';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import styles from './AdminModal.module.css';

const PLAN_OPTIONS = [
  { value: 'trial', label: 'Trial' },
  { value: 'standard', label: 'Standard' },
  { value: 'professional', label: 'Professional' },
  { value: 'enterprise', label: 'Enterprise' },
];

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
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
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
    if (!beginSubmit()) return;
    setError(null);

    try {
      const tenant = await createTenant(formData);
      onCreated(tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
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
          <h2 id={titleId} className={styles.title}>Create Tenant</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form id="create-tenant-form" onSubmit={handleSubmit} className={styles.body}>
            <div className={styles.form}>
              <Input
                label="Tenant Name *"
                type="text"
                name="name"
                fullWidth
                value={formData.name}
                onChange={handleNameChange}
                placeholder="Acme Corporation"
                required
                disabled={isSubmitting}
              />

              <Input
                label="URL Slug *"
                type="text"
                name="slug"
                fullWidth
                value={formData.slug}
                onChange={handleChange}
                placeholder="acme-corp"
                pattern="[a-z0-9-]+"
                required
                disabled={isSubmitting}
                hint={`Access URL: /t/${formData.slug || 'slug'}/`}
              />

              <Input
                label="Company Name"
                type="text"
                name="company_name"
                fullWidth
                value={formData.company_name}
                onChange={handleChange}
                placeholder="Acme Corporation Inc."
                disabled={isSubmitting}
              />

              <Input
                label="Admin Email *"
                type="email"
                name="admin_email"
                fullWidth
                value={formData.admin_email}
                onChange={handleChange}
                placeholder="admin@acme.com"
                required
                disabled={isSubmitting}
              />

              <div className={styles.formRow}>
                <Select
                  label="Plan"
                  name="plan"
                  fullWidth
                  value={formData.plan}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  options={PLAN_OPTIONS}
                />

                <Input
                  label="Max Users"
                  type="number"
                  name="max_users"
                  fullWidth
                  value={formData.max_users}
                  onChange={handleChange}
                  min="1"
                  disabled={isSubmitting}
                />
              </div>

              <Input
                label="Max Projects"
                type="number"
                name="max_projects"
                fullWidth
                value={formData.max_projects}
                onChange={handleChange}
                min="1"
                disabled={isSubmitting}
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
            form="create-tenant-form"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create Tenant'}
          </button>
        </div>
      </div>
    </div>
  );
}
