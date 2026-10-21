/**
 * TeamChecklist - tick some of a site's teams (project teams, the teams a
 * tag, piece of equipment or company event is limited to).
 *
 * Picking several items from a list is the one place a raw checkbox is right
 * (UI_GUIDELINES §3.4); each sits inside its label so the label row is the
 * touch target (§7). An inactive team is listed by the caller only while it is
 * still ticked, and is marked so it can be unticked.
 */

import type { Team } from '@/types';
import styles from './TeamChecklist.module.css';

export interface TeamChecklistProps {
  teams: Team[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** Accessible name of the group */
  label: string;
  disabled?: boolean;
  /** Shown instead of the checkboxes when there is no team */
  emptyText?: string;
}

export function TeamChecklist({ teams, selected, onChange, label, disabled = false, emptyText }: TeamChecklistProps) {
  const toggle = (teamId: number, checked: boolean) => {
    onChange(checked ? [...selected, teamId] : selected.filter((id) => id !== teamId));
  };

  return (
    <div className={styles.checklist} role="group" aria-label={label}>
      {teams.length === 0 && emptyText && <span className={styles.empty}>{emptyText}</span>}
      {teams.map((team) => {
        const checked = selected.includes(team.id);
        return (
          <label key={team.id} className={`${styles.check} ${disabled ? styles.disabled : ''}`}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={(e) => toggle(team.id, e.target.checked)}
            />
            <span
              className={styles.dot}
              style={team.color ? { backgroundColor: team.color } : undefined}
              aria-hidden="true"
            />
            <span>{team.name}</span>
            {!team.active && checked && <span className={styles.inactive}> (inactive)</span>}
          </label>
        );
      })}
    </div>
  );
}
