/**
 * TagPicker - choose a project's tags.
 *
 * A thin wrapper over the shared OptionPicker: tags are created, renamed and
 * recoloured in Settings → Tags (holders of tags.manage get a "Manage tags…"
 * shortcut here).
 *
 * Only tags that apply to the project's site are offered (`all_sites`, or the
 * site is in `site_ids`), and of those limited to teams there, only the ones
 * sharing a team with the project (`teamIds`). Tags are listed in tag order.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { OptionPicker } from '@/components/common/OptionPicker';
import { tagsForProjectScope } from '@/utils/tags';
import { teamsForSite } from '@/utils/teams';
import { ManageSettingsLink } from './ManageSettingsLink';

/** Search box placeholder (referenced by scripts/screenshots). */
export const TAG_PICKER_PLACEHOLDER = 'Find a tag...';

/** Confirmation shown before "Manage tags…" leaves the enclosing dialog. */
export const MANAGE_TAGS_CONFIRM =
  'Open Settings → Tags? This closes the dialog and discards unsaved changes.';

interface TagPickerProps {
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
  /** Site of the project being edited; decides which tags are offered. */
  siteId: number | null;
  /** The project's teams; a tag limited to teams is offered only if one is among them. */
  teamIds?: number[];
  /** Lock the picker (e.g. while the enclosing dialog's save is in flight). */
  disabled?: boolean;
}

const NO_TEAMS: number[] = [];

export function TagPicker({ selectedIds, onChange, siteId, teamIds = NO_TEAMS, disabled = false }: TagPickerProps) {
  const tags = useAppStore((s) => s.tags);
  const teams = useAppStore((s) => s.teams);

  const siteTags = useMemo(
    () =>
      tagsForProjectScope(tags, siteId, teamIds, teamsForSite(teams, siteId)).sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
      ),
    [tags, siteId, teamIds, teams]
  );

  return (
    <OptionPicker
      options={siteTags}
      selectedIds={selectedIds}
      onChange={onChange}
      searchLabel="Find a tag"
      placeholder={TAG_PICKER_PLACEHOLDER}
      emptyText="No tags"
      noOptionsText="No tags for this site"
      noMatchText="No tags match"
      disabled={disabled}
      action={
        <ManageSettingsLink
          section="tags"
          label="Manage tags…"
          confirmTitle="Manage tags"
          confirmMessage={MANAGE_TAGS_CONFIRM}
          blockedAction="Managing tags"
          permission="tags.manage"
          disabled={disabled}
        />
      }
    />
  );
}
