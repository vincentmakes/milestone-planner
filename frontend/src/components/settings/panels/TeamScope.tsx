/**
 * TeamScope - limit something site-scoped (a tag, equipment, a company event)
 * to some teams of one site.
 *
 * Per site it is either the whole site (none of that site's team ids in the
 * selection) or some of its teams. `selected` is the flat list across sites;
 * only this site's ids are edited and the rest are passed through untouched.
 * Renders nothing for a site without teams.
 */

import { useState } from 'react';
import { TeamChecklist } from '@/components/common/TeamChecklist';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { replaceSiteTeamIds, teamIdsOnSite, teamsForSite } from '@/utils/teams';
import type { Site, Team } from '@/types';
import styles from './TeamScope.module.css';

interface TeamScopeProps {
  site: Site;
  teams: Team[];
  /** Team ids across every site */
  selected: number[];
  onChange: (nextAll: number[]) => void;
  /** Several sites are in scope: name the site in the switch */
  multiSite?: boolean;
  disabled?: boolean;
}

export function TeamScope({ site, teams, selected, onChange, multiSite = false, disabled = false }: TeamScopeProps) {
  // The site's active teams, plus an inactive one while it is still ticked.
  const siteTeams = teamsForSite(teams, site.id).filter((t) => t.active || selected.includes(t.id));
  const siteSelection = teamIdsOnSite(selected, siteTeams);
  const [restricted, setRestricted] = useState(siteSelection.length > 0);

  if (siteTeams.length === 0) return null;

  return (
    <div className={styles.scope}>
      <ToggleSwitch
        label={multiSite ? `Whole site — ${site.name}` : 'Whole site'}
        checked={!restricted}
        disabled={disabled}
        onChange={(on) => {
          setRestricted(!on);
          if (on) onChange(replaceSiteTeamIds(selected, siteTeams, []));
        }}
      />
      {restricted && (
        <>
          <TeamChecklist
            teams={siteTeams}
            selected={siteSelection}
            onChange={(next) => onChange(replaceSiteTeamIds(selected, siteTeams, next))}
            label={`Teams of ${site.name}`}
            disabled={disabled}
          />
          {siteSelection.length === 0 && (
            <p className={styles.hint}>No team ticked — stays open to the whole site.</p>
          )}
        </>
      )}
    </div>
  );
}
