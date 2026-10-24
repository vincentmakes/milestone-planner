/**
 * DashboardDialog — a new dashboard's name, description and sharing, or the
 * sharing of the open one (2.1.0).
 *
 * Visibility: *Private* (the owner, and admins), *Shared with…* (the targets
 * chosen below — roles, sites, teams and people; anyone matching one of them
 * sees it, view only; at least one target) or *Everyone* (everyone who can
 * open the Dashboards view). The targets: Roles (`RoleChecklist`; the
 * administrators always see every dashboard), Sites (the user's visible
 * sites), Teams (the teams at those sites, inactive ones marked) and People
 * (`GET /dashboards/shareable-users`, loaded when the dialog opens), each a
 * searchable `MultiSelectDropdown`. A target already on the dashboard that
 * the user could not pick now (a site they left) stays listed, so a save
 * keeps it.
 *
 * Two uses:
 * - **New** (name, description, sharing): the values go back to the view,
 *   which starts an empty draft in edit mode; nothing is sent until the
 *   builder saves.
 * - **Share…** (sharing only — the name and description are edited inline in
 *   edit mode): Save sends the dashboard's current name and description with
 *   the new sharing, without a `widgets` key (the server keeps the widgets),
 *   and the saved dashboard is shown.
 * Errors (no target, the server's refusal) show in a `Notice`. `onDone`
 * also receives the chosen targets with their names, so the view can show a
 * new draft's "Shared with" line before the server has resolved them.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { Notice } from '@/components/common/Notice';
import { RoleChecklist } from '@/components/common/RoleChecklist';
import { MultiSelectDropdown } from '@/components/common/MultiSelectDropdown';
import type { MultiSelectDropdownItem } from '@/components/common/MultiSelectDropdown';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useRoles } from '@/hooks/useRoles';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { useDashboardStore } from '@/stores/dashboardStore';
import type { DashboardVisibility, ShareableUser, SharedWith } from '@/types';
import { plainError } from './useDashboardEditor';
import { savedTargets } from './widgetDraft';
import type { DashboardMeta } from './widgetDraft';
import styles from './DashboardDialog.module.css';

export const NAME_REQUIRED = 'Enter a name';
export const TARGET_REQUIRED = 'Choose at least one role, site, team or person';
export const PEOPLE_LOADING = 'Loading people…';
export const PEOPLE_FAILED = 'People could not be loaded';
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

const VISIBILITY_OPTIONS: { value: DashboardVisibility; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'shared', label: 'Shared with…' },
  { value: 'everyone', label: 'Everyone' },
];

const VISIBILITY_HINTS: Record<DashboardVisibility, string> = {
  private: 'Only you (and administrators) see it.',
  shared:
    'People holding one of these roles, at one of these sites, in one of these teams or named here see it, ' +
    'with their own numbers. They cannot change it.',
  everyone: 'Everyone who can open Dashboards sees it, with their own numbers.',
};

/** `extra` items not among `items`, appended (targets kept from the dashboard). */
function withKept(items: MultiSelectDropdownItem[], extra: MultiSelectDropdownItem[]): MultiSelectDropdownItem[] {
  const ids = new Set(items.map((i) => i.id));
  return [...items, ...extra.filter((i) => !ids.has(i.id))];
}

const byName = <T extends { name: string; id: number }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);

/** The chosen ids of one kind as named targets (items offered, in name order). */
function chosen<T extends { id: number; name: string }>(items: readonly T[], ids: readonly number[]): T[] {
  const set = new Set(ids);
  return byName(items.filter((i) => set.has(i.id)));
}

/** A person's hint in the picker: job title · their sites. */
const personHint = (user: ShareableUser): string | undefined =>
  [user.job_title, user.site_names.join(', ')].filter(Boolean).join(' · ') || undefined;

export interface DashboardDialogProps {
  /** `new` hands the values back; `share` saves the sharing on `dashboardId` */
  mode: 'new' | 'share';
  /** The values to start from (share: the open dashboard's, name and description included) */
  initial: DashboardMeta;
  /** Share: the open dashboard's targets with their names, kept even when no longer pickable */
  sharedWith?: SharedWith;
  /** The dashboard Share… saves (share mode) */
  dashboardId?: number;
  onClose: () => void;
  /** New: the values chosen. Share: called after the save. With the targets' names */
  onDone: (meta: DashboardMeta, sharedWith: SharedWith) => void;
}

type PeopleState = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; users: ShareableUser[] };

export function DashboardDialog({ mode, initial, sharedWith, dashboardId, onClose, onDone }: DashboardDialogProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [visibility, setVisibility] = useState<DashboardVisibility>(initial.visibility);
  const [roleIds, setRoleIds] = useState<number[]>(initial.role_ids);
  const [siteIds, setSiteIds] = useState<number[]>(initial.site_ids);
  const [teamIds, setTeamIds] = useState<number[]>(initial.team_ids);
  const [userIds, setUserIds] = useState<number[]>(initial.user_ids);
  const [people, setPeople] = useState<PeopleState>({ status: 'loading' });
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting, begin, end } = useSubmitGuard();
  const roles = useRoles();
  const sites = useVisibleSites();
  const teams = useAppStore((s) => s.teams);
  const allSites = useAppStore((s) => s.sites);

  // The people picker's list, once per opening.
  useEffect(() => {
    let cancelled = false;
    dashboardsApi
      .shareableUsers()
      .then((users) => {
        if (!cancelled) setPeople({ status: 'loaded', users });
      })
      .catch((err: unknown) => {
        console.error('[Dashboards] Failed to load the people to share with', err);
        if (!cancelled) setPeople({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const siteItems = useMemo(
    () =>
      withKept(
        sites.map((s) => ({ id: s.id, name: s.name })),
        (sharedWith?.sites ?? []).map((s) => ({ id: s.id, name: s.name }))
      ),
    [sites, sharedWith]
  );

  const teamItems = useMemo(() => {
    const visible = new Set(sites.map((s) => s.id));
    const siteName = new Map(allSites.map((s) => [s.id, s.name]));
    const pickable = teams
      .filter((t) => visible.has(t.site_id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color ?? undefined,
        // The team's site, and whether it is inactive
        hint: [siteName.get(t.site_id), t.active === false ? '(inactive)' : null].filter(Boolean).join(' ') || undefined,
      }));
    const kept = (sharedWith?.teams ?? []).map((t) => ({ id: t.id, name: t.name, hint: t.site_name || undefined }));
    return withKept(pickable, kept);
  }, [teams, sites, allSites, sharedWith]);

  // A team's site name, for the names handed back (`shared_with.teams`).
  const teamSiteName = useMemo(() => {
    const siteName = new Map(allSites.map((s) => [s.id, s.name]));
    const out = new Map<number, string>();
    for (const t of teams) out.set(t.id, siteName.get(t.site_id) ?? '');
    for (const t of sharedWith?.teams ?? []) if (!out.has(t.id)) out.set(t.id, t.site_name);
    return out;
  }, [teams, allSites, sharedWith]);

  const userItems = useMemo(
    () =>
      withKept(
        people.status === 'loaded'
          ? people.users.map((u) => ({ id: u.id, name: u.name, hint: personHint(u) }))
          : [],
        (sharedWith?.users ?? []).map((u) => ({ id: u.id, name: u.name }))
      ),
    [people, sharedWith]
  );

  const changeTargets = (set: (ids: number[]) => void) => (ids: number[]) => {
    set(ids);
    setError(null);
  };

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    // Share… edits the sharing only: the name and description are kept.
    const trimmed = mode === 'share' ? initial.name : name.trim();
    if (mode === 'new') setNameError(trimmed ? null : NAME_REQUIRED);
    const noTarget =
      visibility === 'shared' && roleIds.length + siteIds.length + teamIds.length + userIds.length === 0;
    setError(noTarget ? TARGET_REQUIRED : null);
    if (!trimmed || noTarget) return;
    const meta: DashboardMeta = {
      name: trimmed,
      description: mode === 'share' ? initial.description : description.trim() || null,
      visibility,
      ...savedTargets({ visibility, role_ids: roleIds, site_ids: siteIds, team_ids: teamIds, user_ids: userIds }),
    };
    const names: SharedWith = {
      roles: chosen(
        roles.map((r) => ({ id: r.id, name: r.name })),
        meta.role_ids
      ),
      sites: chosen(siteItems, meta.site_ids).map(({ id, name }) => ({ id, name })),
      teams: chosen(teamItems, meta.team_ids).map(({ id, name }) => ({
        id,
        name,
        site_name: teamSiteName.get(id) ?? '',
      })),
      users: chosen(userItems, meta.user_ids).map(({ id, name }) => ({ id, name })),
    };
    if (mode === 'new') {
      onDone(meta, names);
      return;
    }
    if (dashboardId === undefined || !begin()) return;
    try {
      // No `widgets` key: the server keeps the dashboard's widgets.
      const saved = await useDashboardStore.getState().save({ id: dashboardId, ...meta });
      onDone(meta, saved.shared_with);
    } catch (err) {
      console.error('[Dashboards] Failed to share a dashboard', err);
      setError(plainError(err, 'The dashboard could not be saved.'));
    } finally {
      end();
    }
  };

  const footer = (
    <div className={styles.footer}>
      <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button type="button" onClick={() => void handleSubmit()} loading={isSubmitting}>
        {mode === 'new' ? 'Create dashboard' : 'Save Changes'}
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={mode === 'new' ? 'New dashboard' : 'Share dashboard'}
      size="md"
      footer={footer}
    >
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)} noValidate>
        {error && <Notice tone="error">{error}</Notice>}
        {mode === 'new' && (
          <>
            <Input
              label="Name *"
              fullWidth
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              error={nameError ?? undefined}
              autoFocus
            />
            <Input
              label="Description"
              fullWidth
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </>
        )}
        <Select
          label="Visibility"
          fullWidth
          value={visibility}
          onChange={(e) => {
            setVisibility(e.target.value as DashboardVisibility);
            setError(null);
          }}
          options={VISIBILITY_OPTIONS}
          hint={VISIBILITY_HINTS[visibility]}
        />
        {visibility === 'shared' && (
          <div className={styles.targets}>
            <div className={styles.group}>
              <span className={styles.label}>Roles</span>
              <RoleChecklist
                roles={roles}
                selected={roleIds}
                onChange={changeTargets(setRoleIds)}
                label="Roles that see this dashboard"
                emptyText="Loading roles…"
              />
            </div>
            <MultiSelectDropdown
              label="Sites"
              options={siteItems}
              selectedIds={new Set(siteIds)}
              onChange={changeTargets(setSiteIds)}
              searchable
              searchLabel="Find a site"
              searchPlaceholder="Type to find a site…"
              noMatchText="No site matches"
              emptyText="No site"
            />
            <MultiSelectDropdown
              label="Teams"
              options={teamItems}
              selectedIds={new Set(teamIds)}
              onChange={changeTargets(setTeamIds)}
              searchable
              searchLabel="Find a team"
              searchPlaceholder="Type to find a team…"
              noMatchText="No team matches"
              emptyText="No team at your sites"
            />
            <div className={styles.group}>
              <MultiSelectDropdown
                label="People"
                options={userItems}
                selectedIds={new Set(userIds)}
                onChange={changeTargets(setUserIds)}
                disabled={people.status !== 'loaded'}
                placeholder={people.status === 'loading' ? PEOPLE_LOADING : 'None'}
                searchable
                searchLabel="Find a person"
                searchPlaceholder="Type to find a person…"
                noMatchText="No one matches"
                emptyText="No one to share with"
              />
              {people.status === 'failed' && <Notice tone="warning">{PEOPLE_FAILED}</Notice>}
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
