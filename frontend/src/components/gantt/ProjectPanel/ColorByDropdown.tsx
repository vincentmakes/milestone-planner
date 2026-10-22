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
import { Icon, PaletteIcon } from '@/components/common/Icon';

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
        <Icon icon={PaletteIcon} size={14} />
      }
      value={group}
      groups={tagGroups}
      onChange={setGroup}
      disabled={siteId === null}
    />
  );
}
