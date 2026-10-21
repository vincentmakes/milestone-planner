/**
 * TeamSelector - the header's team filter for the current site.
 *
 * "Whole site" (no filter), any of the site's active teams and "(No team)";
 * the choice is stored per tenant + site in viewStore.teamFilters and read by
 * the views through useTeamFilter. A site without active teams shows nothing.
 *
 * The panel is a non-modal dialog of checkboxes (the TagFilterDropdown shell)
 * and dismisses through useDismissableOverlay. Below the `full` header tier the
 * trigger drops its label and keeps the icon and chevron (data-density rules
 * in the module).
 */

import { useId, useMemo, useRef, useState } from 'react';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { useViewStore } from '@/stores/viewStore';
import { normalizeTeamFilter, teamFilterLabel } from '@/utils/teams';
import type { TeamFilter } from '@/utils/teams';
import styles from './TeamSelector.module.css';

const NO_FILTER: TeamFilter = { teamIds: [], noTeam: false };

export function TeamSelector() {
  const { siteId, siteTeams, filter, active } = useTeamFilter();
  const setTeamFilter = useViewStore((s) => s.setTeamFilter);
  const clearTeamFilter = useViewStore((s) => s.clearTeamFilter);

  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const { onBlur: handleBlur } = useDismissableOverlay({
    open,
    onClose: () => setOpen(false),
    wrapperRef,
    triggerRef,
  });

  const selectedIds = useMemo(() => new Set(filter?.teamIds ?? []), [filter]);

  if (siteId === null || siteTeams.length === 0) return null;

  const current = filter ?? NO_FILTER;
  const label = teamFilterLabel(filter, siteTeams);

  // Normalised so ids of deleted or deactivated teams are dropped; an empty
  // filter makes the store delete the site's entry (Whole site).
  const write = (next: TeamFilter) =>
    setTeamFilter(siteId, normalizeTeamFilter(next, siteTeams) ?? NO_FILTER);

  const toggleTeam = (teamId: number) =>
    write({
      teamIds: selectedIds.has(teamId)
        ? current.teamIds.filter((id) => id !== teamId)
        : [...current.teamIds, teamId],
      noTeam: current.noTeam,
    });

  const toggleNoTeam = () => write({ teamIds: current.teamIds, noTeam: !current.noTeam });

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${active ? styles.active : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={`Team filter: ${label}`}
        title="Filter by team"
      >
        <svg className={styles.icon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span className={styles.label}>{label}</span>
        <svg className={styles.chevron} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div id={panelId} role="dialog" aria-label="Filter by team" className={styles.dropdown}>
          <div className={styles.header}>
            <span>Filter by team</span>
            {active && (
              <button type="button" className={styles.clearBtn} onClick={() => clearTeamFilter(siteId)}>
                Clear
              </button>
            )}
          </div>

          <div className={styles.list} role="group" aria-label="Teams">
            <label className={styles.option}>
              <input type="checkbox" checked={!active} onChange={() => clearTeamFilter(siteId)} />
              <span className={styles.checkbox}>
                <CheckIcon />
              </span>
              <span className={styles.name}>Whole site</span>
            </label>
            {siteTeams.map((team) => (
              <label key={team.id} className={styles.option}>
                <input type="checkbox" checked={selectedIds.has(team.id)} onChange={() => toggleTeam(team.id)} />
                <span className={styles.checkbox}>
                  <CheckIcon />
                </span>
                <span
                  className={styles.dot}
                  style={team.color ? { backgroundColor: team.color } : undefined}
                  aria-hidden="true"
                />
                <span className={styles.name}>{team.name}</span>
              </label>
            ))}
            <label className={styles.option}>
              <input type="checkbox" checked={current.noTeam} onChange={toggleNoTeam} />
              <span className={styles.checkbox}>
                <CheckIcon />
              </span>
              <span className={styles.noneLabel}>(No team)</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg className={styles.checkIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
