/**
 * TeamForm (Settings hub > Teams > edit)
 *
 * Name, description, colour, active flag and members of one team. Members
 * are the people of the team's site (one staff row per user-site pair);
 * inactive people are offered only while they are still members, so they can
 * be removed.
 */

import { useMemo, useState } from 'react';
import { teamsApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_TEAM_COLOR, TEAM_COLOR_SWATCHES } from '@/utils/colorSwatches';
import type { Team } from '@/types';
import { useReportDirty } from '../useReportDirty';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { BackIcon } from './PanelIcons';
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

  const toggleMember = (id: number) =>
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      <Button type="button" variant="ghost" icon={<BackIcon />} className={styles.backLink} onClick={onBack}>
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

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Members</span>
        {people.length === 0 ? (
          <div className={styles.membersEmpty}>No people on this site yet.</div>
        ) : (
          <div role="group" aria-label="Team members" className={styles.memberList}>
            {people.map((person) => (
              <label key={person.id} className={styles.member}>
                <input
                  type="checkbox"
                  checked={memberIds.has(person.id)}
                  onChange={() => toggleMember(person.id)}
                />
                <span className={styles.memberName}>{person.name}</span>
                {person.role && <span className={styles.memberRole}>{person.role}</span>}
              </label>
            ))}
          </div>
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
