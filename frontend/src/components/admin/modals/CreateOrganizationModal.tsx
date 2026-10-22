/**
 * CreateOrganizationModal
 * Modal for creating a new organization
 */

import { useId, useState } from 'react';
import { Notice } from '@/components/common/Notice';
import { Input } from '@/components/common/Input';
import { createOrganization } from '@/api';
import { useEscapeKey } from '@/hooks';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import styles from './AdminModal.module.css';
import { Icon, CloseIcon } from '@/components/common/Icon';

interface CreateOrganizationModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateOrganizationModal({ onClose, onCreated }: CreateOrganizationModalProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 63);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    // Auto-generate slug if user hasn't manually edited it
    if (!slug || slug === generateSlug(name)) {
      setSlug(generateSlug(value));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !slug.trim()) {
      setError('Name and slug are required');
      return;
    }

    // Validate slug format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
      setError('Slug must start and end with a letter/number and contain only lowercase letters, numbers, and hyphens');
      return;
    }

    if (!beginSubmit()) return;

    try {
      await createOrganization({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization');
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
          <h2 id={titleId} className={styles.title}>Create Organization</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close dialog">
            <Icon icon={CloseIcon} size={20} />
          </button>
        </div>

        <form className={styles.body} onSubmit={handleSubmit}>
          {error && <Notice tone="error">{error}</Notice>}

          <div className={styles.form}>
            <Input
              label="Name *"
              type="text"
              id="orgName"
              fullWidth
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Acme Corporation"
              required
            />

            <Input
              label="Slug *"
              type="text"
              id="orgSlug"
              fullWidth
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="acme-corp"
              required
              hint="Used in URLs. Only lowercase letters, numbers, and hyphens."
            />

            <Input
              label="Description"
              type="text"
              id="orgDesc"
              fullWidth
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description of the organization"
            />
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
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create Organization'}
          </button>
        </div>
      </div>
    </div>
  );
}
