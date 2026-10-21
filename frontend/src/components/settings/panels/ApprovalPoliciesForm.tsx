/**
 * ApprovalPoliciesForm (Settings hub > Roles > Approvals)
 *
 * Who approves a request filed by a role holding an own-booking key in
 * "Needs approval" mode: one card per approvable action with "The project's
 * manager can approve" and the roles whose holders may approve. Admins
 * always may (the admin role is ticked and disabled); a warning shows when
 * nobody else would. Each card saves on its own (PUT
 * /api/approval-policies/{action}); requests already pending keep the
 * approvers they were filed with.
 */

import { useEffect, useId, useState } from 'react';
import { rolesApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { RoleChecklist } from '@/components/common/RoleChecklist';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { ADMIN_ROLE_KEY } from '@/types/permissions';
import type { ApprovalPolicy, Role, UpdateApprovalPolicyRequest } from '@/types';
import { useReportDirty } from '../useReportDirty';
import styles from './RolesPanel.module.css';

interface ApprovalPoliciesFormProps {
  /** Every role (the checklist), admin included */
  roles: Role[];
  /** Unsaved input in any card (reported to the Settings hub by the panel) */
  onDirtyChange?: (dirty: boolean) => void;
}

type Draft = UpdateApprovalPolicyRequest;

const sortedIds = (ids: number[]) => [...ids].sort((a, b) => a - b);

function sameDraft(a: Draft, b: Draft): boolean {
  return a.pm_approves === b.pm_approves && sortedIds(a.role_ids).join(',') === sortedIds(b.role_ids).join(',');
}

const toDraft = (policy: ApprovalPolicy): Draft => ({ pm_approves: policy.pm_approves, role_ids: policy.role_ids });

interface PolicyCardProps {
  policy: ApprovalPolicy;
  draft: Draft;
  roles: Role[];
  adminRoleIds: Set<number>;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  saved: boolean;
  onChange: (draft: Draft) => void;
  onSave: () => void;
}

function PolicyCard({ policy, draft, roles, adminRoleIds, saving, disabled, error, saved, onChange, onSave }: PolicyCardProps) {
  const titleId = useId();
  const dirty = !sameDraft(draft, toDraft(policy));
  const onlyAdmins = !draft.pm_approves && draft.role_ids.every((id) => adminRoleIds.has(id));

  return (
    <section className={styles.policy} aria-labelledby={titleId}>
      <h4 id={titleId} className={styles.policyTitle}>
        {policy.label}
      </h4>
      {error && <Notice tone="error">{error}</Notice>}
      {saved && !dirty && <Notice tone="success">Saved.</Notice>}
      <ToggleSwitch
        checked={draft.pm_approves}
        onChange={(pm_approves) => onChange({ ...draft, pm_approves })}
        label="The project's manager can approve"
      />
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Roles that can approve</span>
        <RoleChecklist
          roles={roles}
          selected={draft.role_ids}
          onChange={(role_ids) => onChange({ ...draft, role_ids })}
          label={`Roles that can approve: ${policy.label}`}
          emptyText="Loading roles..."
        />
      </div>
      {onlyAdmins && <Notice tone="warning">Only administrators can approve these requests.</Notice>}
      <div className={styles.policyActions}>
        <Button onClick={onSave} loading={saving} disabled={!dirty || disabled}>
          Save Changes
        </Button>
      </div>
    </section>
  );
}

export function ApprovalPoliciesForm({ roles, onDirtyChange }: ApprovalPoliciesFormProps) {
  const [policies, setPolicies] = useState<ApprovalPolicy[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [savedAction, setSavedAction] = useState<string | null>(null);
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();

  useEffect(() => {
    let cancelled = false;
    rolesApi
      .getApprovalPolicies()
      .then((loaded) => {
        if (cancelled) return;
        setPolicies(loaded);
        setDrafts(Object.fromEntries(loaded.map((p) => [p.action, toDraft(p)])));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load approval policies');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adminRoleIds = new Set(roles.filter((r) => r.key === ADMIN_ROLE_KEY).map((r) => r.id));

  useReportDirty(
    onDirtyChange,
    (policies ?? []).some((p) => drafts[p.action] && !sameDraft(drafts[p.action], toDraft(p)))
  );

  const handleSave = async (policy: ApprovalPolicy) => {
    if (!beginSubmit()) return;
    const draft = drafts[policy.action];
    setSavingAction(policy.action);
    setSavedAction(null);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[policy.action];
      return next;
    });
    try {
      const updated = await rolesApi.updateApprovalPolicy(policy.action, {
        pm_approves: draft.pm_approves,
        role_ids: sortedIds(draft.role_ids),
      });
      setPolicies((prev) => (prev ?? []).map((p) => (p.action === updated.action ? updated : p)));
      setDrafts((prev) => ({ ...prev, [updated.action]: toDraft(updated) }));
      setSavedAction(updated.action);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [policy.action]: err instanceof Error ? err.message : 'Failed to save approval policy',
      }));
    } finally {
      setSavingAction(null);
      endSubmit();
    }
  };

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!policies) return <div className={styles.empty}>Loading approval policies...</div>;

  return (
    <div className={styles.policies}>
      <p className={styles.intro}>
        When a role holds an own-booking permission in "Needs approval" mode, its holders' changes wait
        for one of these approvers. Administrators can always approve.
      </p>
      {policies.map((policy) => (
        <PolicyCard
          key={policy.action}
          policy={policy}
          draft={drafts[policy.action] ?? toDraft(policy)}
          roles={roles}
          adminRoleIds={adminRoleIds}
          saving={savingAction === policy.action}
          disabled={isSubmitting}
          error={errors[policy.action] ?? null}
          saved={savedAction === policy.action}
          onChange={(draft) => {
            setSavedAction(null);
            setDrafts((prev) => ({ ...prev, [policy.action]: draft }));
          }}
          onSave={() => handleSave(policy)}
        />
      ))}
    </div>
  );
}
