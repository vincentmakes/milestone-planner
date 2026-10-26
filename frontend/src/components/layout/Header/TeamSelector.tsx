/**
 * TeamSelector - the header's team filter for the current site.
 *
 * "Whole site" (no filter), any of the site's active teams and "(No team)";
 * the choice is stored per tenant + site in viewStore.teamFilters and read by
 * the views through useTeamFilter. A site without active teams shows nothing.
 *
 * The panel is a non-modal dialog of checkboxes (the ProjectFilterDropdown shell)
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
import { Icon, ChevronDownIcon, UsersIcon, CheckIcon } from '@/components/common/Icon';

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
        <Icon icon={UsersIcon} size={16} className={styles.icon} />
        <span className={styles.label}>{label}</span>
        <Icon icon={ChevronDownIcon} size={12} className={styles.chevron} />
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
                <Tick />
              </span>
              <span className={styles.name}>Whole site</span>
            </label>
            {siteTeams.map((team) => (
              <label key={team.id} className={styles.option}>
                <input type="checkbox" checked={selectedIds.has(team.id)} onChange={() => toggleTeam(team.id)} />
                <span className={styles.checkbox}>
                  <Tick />
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
                <Tick />
              </span>
              <span className={styles.noneLabel}>(No team)</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** The tick drawn in a checked option's box (shown by CSS) */
function Tick() {
  return <Icon icon={CheckIcon} size={12} className={styles.checkIcon} />;
}
