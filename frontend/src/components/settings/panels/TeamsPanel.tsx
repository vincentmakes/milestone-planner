/**
 * TeamsPanel (Settings hub > Teams)
 *
 * The teams of one site: pick the site in the toolbar, add a team inline, edit
 * it (name, description, colour, active, members) in TeamForm, or delete it.
 * Every visible site (useVisibleSites: all with sites.view_all, else the
 * user's own), matching the backend.
 */

import { useState } from 'react';
import { teamsApi } from '@/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { Select } from '@/components/common/Select';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_TEAM_COLOR } from '@/utils/colorSwatches';
import { confirmAction } from '@/utils/confirmDialog';
import { teamsForSite } from '@/utils/teams';
import type { Team } from '@/types';
import { PanelToolbar } from '../PanelToolbar';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { pickDefaultSiteId } from './calendarUtils';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { Icon, EditIcon, PlusIcon, TrashIcon } from '@/components/common/Icon';
import { TeamForm } from './TeamForm';
import styles from './TeamsPanel.module.css';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function TeamsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const teams = useAppStore((s) => s.teams);
  const currentSite = useAppStore((s) => s.currentSite);
  const manageable = useVisibleSites();
  const { refreshTeams, refreshStaff } = useDataLoader();

  // The picked site while it stays manageable, else the default one.
  const [pickedSiteId, setPickedSiteId] = useState<number | null>(null);
  const siteId =
    pickedSiteId !== null && manageable.some((s) => s.id === pickedSiteId)
      ? pickedSiteId
      : pickDefaultSiteId(manageable, currentSite?.id);
  const siteTeams = teamsForSite(teams, siteId);

  const [editingId, setEditingId] = useState<number | null>(null);
  const editingTeam = teams.find((t) => t.id === editingId) ?? null;

  const [newName, setNewName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One guard for the panel's writes (add, delete); the spinner shows on Add
  // only while an add runs.
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();

  // Unsaved input of the team form; the panel is the hub's single reporter.
  const [formDirty, setFormDirty] = useState(false);
  useReportDirty(onDirtyChange, editingTeam ? formDirty : newName.trim() !== '');

  const handleAdd = async () => {
    const name = newName.trim();
    if (siteId === null) return;
    if (!name) {
      setError('Team name is required');
      return;
    }
    if (!beginSubmit()) return;
    setIsAdding(true);
    setError(null);
    try {
      await teamsApi.create({ site_id: siteId, name, color: DEFAULT_TEAM_COLOR });
      setNewName('');
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add team');
    } finally {
      setIsAdding(false);
      endSubmit();
    }
  };

  const handleDelete = async (team: Team) => {
    // Confirm before taking the guard, so an open dialog never holds it.
    const confirmed = await confirmAction({
      title: 'Delete team',
      message: `Delete team "${team.name}"?\n\nIts members, projects, tags, equipment and company events keep working without it. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed || !beginSubmit()) return;
    setError(null);
    try {
      await teamsApi.delete(team.id);
      await Promise.all([refreshTeams(), refreshStaff()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete team');
    } finally {
      endSubmit();
    }
  };

  if (editingTeam) {
    return (
      <TeamForm
        team={editingTeam}
        onBack={() => setEditingId(null)}
        onSaved={() => setEditingId(null)}
        onDirtyChange={setFormDirty}
      />
    );
  }

  return (
    <div className={styles.container}>
      <PanelToolbar
        align="end"
        left={
          <div className={styles.toolbarLeft}>
            <Select
              label="Site"
              options={manageable.map((s) => ({ value: String(s.id), label: s.name }))}
              value={siteId === null ? '' : String(siteId)}
              onChange={(e) => {
                setPickedSiteId(Number(e.target.value));
                setError(null);
              }}
            />
            <span className={styles.count}>{plural(siteTeams.length, 'team')}</span>
          </div>
        }
      />

      {error && (
        <Notice tone="error" className={styles.notice}>
          {error}
        </Notice>
      )}

      {siteId === null ? (
        <div className={styles.empty}>You don't manage any site yet.</div>
      ) : siteTeams.length === 0 ? (
        <div className={styles.empty}>No teams on this site yet. Add one below.</div>
      ) : (
        <ul className={styles.list}>
          {siteTeams.map((team) => (
            <li key={team.id} className={`${styles.row} ${team.active ? '' : styles.inactive}`}>
              <span
                className={styles.dot}
                style={team.color ? { backgroundColor: team.color } : undefined}
                aria-hidden="true"
              />
              <div className={styles.info}>
                <span className={styles.name}>{team.name}</span>
                {team.description && <span className={styles.description}>{team.description}</span>}
              </div>
              <span className={styles.members}>{plural(team.member_ids.length, 'member')}</span>
              {!team.active && <span className={styles.inactiveBadge}>Inactive</span>}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={() => {
                    setError(null);
                    setEditingId(team.id);
                  }}
                  title="Edit team"
                  aria-label={`Edit ${team.name}`}
                >
                  <Icon icon={EditIcon} size={15} />
                </button>
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.deleteBtn}`}
                  onClick={() => handleDelete(team)}
                  title="Delete team"
                  aria-label={`Delete ${team.name}`}
                >
                  <Icon icon={TrashIcon} size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.addForm}>
        <Input
          type="text"
          className={styles.addInput}
          placeholder="New team name"
          aria-label="New team name"
          maxLength={100}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          disabled={siteId === null}
        />
        <Button
          icon={<Icon icon={PlusIcon} />}
          onClick={handleAdd}
          loading={isAdding}
          disabled={isSubmitting || siteId === null}
        >
          Add team
        </Button>
      </div>
    </div>
  );
}
