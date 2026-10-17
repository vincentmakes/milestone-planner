/**
 * ColorByDropdown - "Colour by tag group" control of the Gantt project panel.
 *
 * Trigger "Colour by" / "Coloured by <group>"; options "Default" plus one per
 * tag group (group display order). The chosen group colours each project bar
 * with the project's tag from it (utils/tags.ts projectBarColor). A per-user,
 * per-site preference (useGanttColorBy), independent of Group by. Shell,
 * close rules and placement: TagGroupChoiceDropdown.
 */

import { useAppStore } from '@/stores/appStore';
import { useGanttColorBy } from '@/hooks/useGanttColorBy';
import { TagGroupChoiceDropdown } from './TagGroupChoiceDropdown';

export function ColorByDropdown() {
  const tagGroups = useAppStore((s) => s.tagGroups);
  const { siteId, group, setGroup } = useGanttColorBy();

  return (
    <TagGroupChoiceDropdown
      triggerLabel="Colour by"
      activeLabel={(g) => `Coloured by ${g.name}`}
      idleTitle="Colour projects by tag group"
      headerLabel="Colour by"
      dialogLabel="Colour projects"
      radioGroupLabel="Colour projects by tag group"
      noneLabel="Default"
      icon={
        /* Palette icon */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z" />
          <circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      }
      value={group}
      groups={tagGroups}
      onChange={setGroup}
      disabled={siteId === null}
    />
  );
}
