/**
 * TeamForm (Settings hub > Teams > edit)
 *
 * Name, description, colour, active flag and members of one team. Members
 * are the people of the team's site (one staff row per user-site pair),
 * picked in a searchable dropdown and listed under it with a remove button;
 * inactive people are offered only while they are still members, so they can
 * be removed. A member the list does not offer (e.g. someone not bookable,
 * absent from GET /staff) is kept as is.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { teamsApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { MultiSelectDropdown } from '@/components/common/MultiSelectDropdown';
import { Notice } from '@/components/common/Notice';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_TEAM_COLOR, TEAM_COLOR_SWATCHES } from '@/utils/colorSwatches';
import type { Team } from '@/types';
import { useReportDirty } from '../useReportDirty';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { Icon, BackIcon, CloseIcon } from '@/components/common/Icon';
import styles from './TeamsPanel.module.css';

interface TeamFormProps {
  team: Team;
  /** Back to the team list without saving */
  onBack: () => void;
  /** Called once the team was saved */
  onSaved: () => void;
  /** Unsaved input in the form (reported to the Settings hub by the panel) */
  onDirtyChange?: (dirty: boolean) => void;
}

const sortedIds = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b);

export function TeamForm({ team, onBack, onSaved, onDirtyChange }: TeamFormProps) {
  const staff = useAppStore((s) => s.staff);
  const { refreshTeams, refreshStaff } = useDataLoader();

  const initialColor = team.color ?? DEFAULT_TEAM_COLOR;
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const [color, setColor] = useState(initialColor);
  const [active, setActive] = useState(team.active);
  const [memberIds, setMemberIds] = useState(() => new Set(team.member_ids));

  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  const people = useMemo(
    () =>
      staff
        .filter((r) => r.site_id === team.site_id && (r.active !== false || team.member_ids.includes(r.id)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [staff, team.site_id, team.member_ids]
  );

  const membersChanged =
    sortedIds(memberIds).join(',') !== sortedIds(team.member_ids).join(',');
  useReportDirty(
    onDirtyChange,
    name !== team.name ||
      description !== (team.description ?? '') ||
      color !== initialColor ||
      active !== team.active ||
      membersChanged
  );

  const memberOptions = useMemo(
    () => people.map((person) => ({ id: person.id, name: person.name, hint: person.role })),
    [people]
  );
  const chosenPeople = useMemo(() => people.filter((person) => memberIds.has(person.id)), [people, memberIds]);

  // The dropdown reports only the people it lists: members it does not list
  // are kept, never dropped silently.
  const setListedMembers = (ids: number[]) =>
    setMemberIds((prev) => {
      const listed = new Set(people.map((person) => person.id));
      return new Set([...[...prev].filter((id) => !listed.has(id)), ...ids]);
    });

  // The × unmounts with its row: focus moves to the × now at that place (the
  // previous one when the last row went), or to the Members trigger.
  const membersFieldRef = useRef<HTMLDivElement>(null);
  const memberListRef = useRef<HTMLUListElement>(null);
  const focusAfterRemove = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const removeButtons = memberListRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    if (removeButtons.length > 0) removeButtons[Math.min(index, removeButtons.length - 1)].focus();
    else membersFieldRef.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')?.focus();
  }, [chosenPeople]);

  const removeMember = (id: number, index: number) => {
    focusAfterRemove.current = index;
    setMemberIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Team name is required');
      return;
    }
    if (!beginSubmit()) return;
    setError(null);
    try {
      await teamsApi.update(team.id, {
        name: name.trim(),
        // An explicit null clears the description.
        description: description.trim() || null,
        color,
        active,
        member_ids: sortedIds(memberIds),
      });
      await Promise.all([refreshTeams(), refreshStaff()]);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save team');
    } finally {
      endSubmit();
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <Button type="button" variant="ghost" icon={<Icon icon={BackIcon} />} className={styles.backLink} onClick={onBack}>
        Back to teams
      </Button>
      <h4 className={styles.formTitle}>Edit team: {team.name}</h4>

      {error && <Notice tone="error">{error}</Notice>}

      <Input
        label="Name *"
        type="text"
        fullWidth
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={100}
      />
      <Input
        label="Description"
        type="text"
        fullWidth
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Optional description"
      />

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Color</span>
        <ColorSwatchPicker
          value={color}
          onChange={setColor}
          label="Team colour"
          swatches={TEAM_COLOR_SWATCHES}
          allowCustom
        />
      </div>

      <ToggleSwitch checked={active} onChange={setActive} label="Active" />

      <div ref={membersFieldRef} className={styles.field}>
        <MultiSelectDropdown
          label="Members"
          searchable
          allowClear={false}
          options={memberOptions}
          selectedIds={memberIds}
          onChange={setListedMembers}
          placeholder="No members"
          emptyText="No people on this site yet."
          summary={(chosen) => (chosen.length === 1 ? '1 member' : `${chosen.length} members`)}
        />
        {chosenPeople.length > 0 && (
          <ul ref={memberListRef} aria-label="Team members" className={styles.memberList}>
            {chosenPeople.map((person, index) => (
              <li key={person.id} className={styles.member}>
                <span className={styles.memberName}>{person.name}</span>
                {person.role && (
                  <>
                    {' '}
                    <span className={styles.memberRole}>· {person.role}</span>
                  </>
                )}
                <button
                  type="button"
                  className={styles.memberRemove}
                  onClick={() => removeMember(person.id, index)}
                  aria-label={`Remove ${person.name}`}
                  title={`Remove ${person.name}`}
                >
                  <Icon icon={CloseIcon} size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.formActions}>
        <Button type="button" variant="secondary" onClick={onBack} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Save Changes
        </Button>
      </div>
    </form>
  );
}
