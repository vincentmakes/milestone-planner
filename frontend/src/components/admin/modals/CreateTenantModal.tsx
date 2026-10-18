/**
 * CreateTenantModal
 * Modal for creating a new tenant. With "Seed demo data" on, the database is
 * provisioned right away and filled with the sample company; otherwise the
 * tenant stays pending until it is provisioned from the list.
 */

import { useId, useState, FormEvent } from 'react';
import { Notice } from '@/components/common/Notice';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { createTenant, provisionTenant } from '@/api';
import type { Tenant, TenantCreateRequest } from '@/api/endpoints/admin';
import { useEscapeKey } from '@/hooks';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { SEED_DEMO_HINT, SEED_DEMO_LABEL } from './ProvisionTenantModal';
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
  /** Shows the admin credentials when the tenant was provisioned right away. */
  onShowCredentials?: (title: string, email: string, password: string) => void;
}

export function CreateTenantModal({ onClose, onCreated, onShowCredentials }: CreateTenantModalProps) {
  const [formData, setFormData] = useState<TenantCreateRequest>({
    name: '',
    slug: '',
    company_name: '',
    admin_email: '',
    plan: 'standard',
    max_users: 10,
    max_projects: 50,
  });
  const [seedDemoData, setSeedDemoData] = useState(false);
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  // Set when the tenant exists but provisioning it failed: the form is done,
  // the dialog only reports and closes (the list offers Provision again).
  const [createdUnprovisioned, setCreatedUnprovisioned] = useState<Tenant | null>(null);

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

    let tenant: Tenant;
    try {
      tenant = (await createTenant(formData)).tenant;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
      endSubmit();
      return;
    }

    if (!seedDemoData) {
      endSubmit();
      onCreated(tenant);
      return;
    }

    try {
      const result = await provisionTenant(tenant.id, { seedDemoData: true });
      onShowCredentials?.('Database Provisioned!', result.adminEmail, result.adminPassword);
      onCreated(tenant);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      setError(
        `The tenant was created, but provisioning failed: ${reason}. ` +
          'Use Provision database in the tenant list to retry.'
      );
      setCreatedUnprovisioned(tenant);
    } finally {
      endSubmit();
    }
  };

  const titleId = useId();
  const handleClose = () => {
    if (createdUnprovisioned) onCreated(createdUnprovisioned);
    else onClose();
  };
  useEscapeKey(handleClose);

  const disabled = isSubmitting || createdUnprovisioned !== null;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>Create Tenant</h2>
          <button type="button" className={styles.closeBtn} onClick={handleClose} aria-label="Close dialog">
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
                disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
              />

              <div className={styles.formRow}>
                <Select
                  label="Plan"
                  name="plan"
                  fullWidth
                  value={formData.plan}
                  onChange={handleChange}
                  disabled={disabled}
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
                  disabled={disabled}
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
                disabled={disabled}
              />

              <div className={styles.formGroup}>
                <ToggleSwitch
                  checked={seedDemoData}
                  onChange={setSeedDemoData}
                  label={SEED_DEMO_LABEL}
                  disabled={disabled}
                />
                <span className={styles.hint}>
                  {SEED_DEMO_HINT} The database is provisioned right away.
                </span>
              </div>

              {error && <Notice tone="error">{error}</Notice>}
            </div>
        </form>

        <div className={styles.footer}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={handleClose}
            disabled={isSubmitting}
          >
            {createdUnprovisioned ? 'Close' : 'Cancel'}
          </button>
          {!createdUnprovisioned && (
            <button
              type="submit"
              form="create-tenant-form"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? seedDemoData
                  ? 'Creating and provisioning...'
                  : 'Creating...'
                : 'Create Tenant'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
