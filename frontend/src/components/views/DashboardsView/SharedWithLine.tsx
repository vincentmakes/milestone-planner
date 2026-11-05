/**
 * SharedWithLine — whom a dashboard is shared with (2.3.0), under its
 * description in view and edit mode.
 *
 * - `everyone`: *Shared with everyone*.
 * - `private`: *Only you (and administrators)* for its owner; anyone else
 *   who sees it (an administrator) reads *Only its owner (and
 *   administrators)*.
 * - `shared`: *Shared with* and one chip per target — roles (shield), sites
 *   (pin), teams (group, with their site) and people (person) — in that
 *   order, names as the server resolved them. With no target left (every
 *   one deleted since) it reads *Shared with no one left*: its owner and the
 *   administrators still see it.
 *
 * The icon of a chip carries its kind as its accessible name.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon, MapPinIcon, PersonIcon, ShieldIcon, UsersIcon } from '@/components/common/Icon';
import type { IconComponent } from '@/components/common/Icon';
import type { DashboardSummary, SharedWith } from '@/types';
import { sharedWithNoOne } from './sharing';
import styles from './SharedWithLine.module.css';

export const EVERYONE_TEXT = 'Shared with everyone';
export const OWNER_ONLY_TEXT = 'Only you (and administrators)';
export const OTHER_OWNER_TEXT = 'Only its owner (and administrators)';
export const NO_TARGET_TEXT = 'Shared with no one left';

interface Chip {
  key: string;
  icon: IconComponent;
  kind: string;
  label: ReactNode;
}

function chipsOf(shared: SharedWith): Chip[] {
  return [
    ...shared.roles.map((r) => ({ key: `r${r.id}`, icon: ShieldIcon, kind: 'Role', label: r.name })),
    ...shared.sites.map((s) => ({ key: `s${s.id}`, icon: MapPinIcon, kind: 'Site', label: s.name })),
    ...shared.teams.map((t) => ({
      key: `t${t.id}`,
      icon: UsersIcon,
      kind: 'Team',
      label: (
        <>
          {t.name}
          {t.site_name && <span className={styles.muted}> · {t.site_name}</span>}
        </>
      ),
    })),
    ...shared.users.map((u) => ({ key: `u${u.id}`, icon: PersonIcon, kind: 'Person', label: u.name })),
  ];
}

export interface SharedWithLineProps {
  dashboard: Pick<DashboardSummary, 'visibility' | 'owner_id' | 'shared_with'>;
  /** The signed-in user */
  userId: number | null;
}

export function SharedWithLine({ dashboard, userId }: SharedWithLineProps) {
  const labelId = useId();
  if (dashboard.visibility === 'everyone') {
    return <p className={styles.line}>{EVERYONE_TEXT}</p>;
  }
  if (dashboard.visibility === 'private') {
    const mine = userId !== null && dashboard.owner_id === userId;
    return <p className={styles.line}>{mine ? OWNER_ONLY_TEXT : OTHER_OWNER_TEXT}</p>;
  }
  if (sharedWithNoOne(dashboard)) {
    return <p className={styles.line}>{NO_TARGET_TEXT}</p>;
  }
  const chips = chipsOf(dashboard.shared_with);
  return (
    <div className={styles.line}>
      <span id={labelId}>Shared with</span>
      <ul className={styles.chips} aria-labelledby={labelId}>
        {chips.map((chip) => (
          <li key={chip.key} className={styles.chip}>
            <Icon icon={chip.icon} size={12} title={chip.kind} className={styles.icon} />
            <span className={styles.name}>{chip.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
