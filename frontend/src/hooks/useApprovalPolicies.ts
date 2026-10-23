/**
 * useApprovalPolicies - who approves each own-booking action
 * (appStore.approvalPolicies), loaded on first use like useRoles: the first
 * component that asks fetches them once (concurrent mounts share the
 * request); the `approvals` WebSocket slice refreshes them once loaded. A
 * failed fetch leaves the list empty and is retried on the next mount.
 *
 * useApproverSummary(action, projectId) - the pending badge's tooltip text
 * for a request on that project (see approverSummary).
 */

import { useEffect } from 'react';
import { rolesApi } from '@/api/endpoints/roles';
import { useAppStore } from '@/stores/appStore';
import { useRoles } from '@/hooks/useRoles';
import { approverSummary } from '@/utils/pendingBookings';
import type { ApprovalPolicy } from '@/types';

let inFlight: Promise<void> | null = null;

function loadOnce(): Promise<void> {
  if (!inFlight) {
    inFlight = rolesApi
      .getApprovalPolicies()
      .catch((err) => {
        console.error('[useApprovalPolicies] Failed to load approval policies', err);
        return [] as ApprovalPolicy[];
      })
      .then((policies) => {
        if (useAppStore.getState().approvalPolicies.length === 0) {
          useAppStore.getState().setApprovalPolicies(policies);
        }
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useApprovalPolicies(): ApprovalPolicy[] {
  const policies = useAppStore((s) => s.approvalPolicies);
  const loaded = policies.length > 0;
  useEffect(() => {
    if (!loaded) void loadOnce();
  }, [loaded]);
  return policies;
}

/** Refetch the policies into the store, only when something already loaded them. */
export async function refreshApprovalPoliciesIfLoaded(): Promise<void> {
  if (useAppStore.getState().approvalPolicies.length === 0) return;
  useAppStore.getState().setApprovalPolicies(await rolesApi.getApprovalPolicies());
}

export function useApproverSummary(action: string, projectId: number | null | undefined): string {
  const policies = useApprovalPolicies();
  const roles = useRoles();
  // Primitive selectors: the manager's name only when the project has one.
  const pmName = useAppStore((s) => {
    const project = s.projects.find((p) => p.id === projectId);
    return project?.pm_id ? (project.pm_name ?? null) : null;
  });
  return approverSummary(
    policies.find((p) => p.action === action),
    roles,
    pmName
  );
}
