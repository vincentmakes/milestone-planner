/**
 * ColorByDropdown - "Colour by" control of the Gantt project panel.
 *
 * Trigger "Colour by" / "Coloured by <choice>"; options "Default", one per
 * dropdown project field applying to the site (field display order) and
 * "Tags" while the site has tags. A field colours each project bar with the
 * project's first item of it, "Tags" with its first tag
 * (utils/projectFilters.ts projectBarColor). A per-user, per-site preference
 * (useGanttColorBy), independent of Group by. Renders nothing when there is
 * no choice. Shell, close rules and placement: FieldChoiceDropdown.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useGanttColorBy } from '@/hooks/useGanttColorBy';
import { tagsForSite } from '@/utils/tags';
import { FieldChoiceDropdown } from './FieldChoiceDropdown';
import type { FieldChoice } from './FieldChoiceDropdown';
import { Icon, PaletteIcon } from '@/components/common/Icon';

const TAGS_CHOICE: FieldChoice<number | 'tags'> = Object.freeze({ id: 'tags', name: 'Tags' });

export function ColorByDropdown() {
  const { siteId, colorBy, fields, setColorBy } = useGanttColorBy();
  const hasSiteTags = useAppStore((s) => tagsForSite(s.tags, siteId).length > 0);

  const choices = useMemo<FieldChoice<number | 'tags'>[]>(
    () => (hasSiteTags ? [...fields, TAGS_CHOICE] : fields),
    [fields, hasSiteTags]
  );
  const value = colorBy === 'tags' ? TAGS_CHOICE : colorBy;

  return (
    <FieldChoiceDropdown<number | 'tags'>
      triggerLabel="Colour by"
      activeLabel={(c) => `Coloured by ${c.name}`}
      idleTitle="Colour projects by a field or the tags"
      headerLabel="Colour by"
      dialogLabel="Colour projects"
      radioGroupLabel="Colour projects by"
      noneLabel="Default"
      icon={<Icon icon={PaletteIcon} size={14} />}
      value={value}
      choices={choices}
      onChange={setColorBy}
      disabled={siteId === null}
    />
  );
}
