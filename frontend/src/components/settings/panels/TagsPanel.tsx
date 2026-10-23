/**
 * TagsPanel (Settings hub > Tags)
 *
 * Tenant-wide project tags, for all sites or only some (and per site
 * optionally only some teams). One flat list: the former tag groups are
 * dropdown project fields since 2.0.0 (Settings → Project fields). Drag to
 * reorder. Writes need tags.manage; the server rejects conflicting changes
 * (409) with a message shown inline.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Notice } from '@/components/common/Notice';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { tagsApi } from '@/api';
import { EVENT_COLOR_SWATCHES } from '@/utils/colorSwatches';
import { teamIdsWithinSites } from '@/utils/teams';
import type { Site, Tag } from '@/types';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { SiteChecklist } from './SiteChecklist';
import { TeamScope } from './TeamScope';
import { useDragReorder, moveId } from './useDragReorder';
import { Icon, DragHandleIcon, EditIcon, TrashIcon, PlusIcon } from '@/components/common/Icon';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './TagsPanel.module.css';

const DEFAULT_TAG_COLOR = EVENT_COLOR_SWATCHES[5].value;
const DRAG_CLASSES = { dragging: styles.dragging, dropBefore: styles.dropBefore, dropAfter: styles.dropAfter };

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function siteSummary(tag: Tag, sites: Site[]): string {
  const teamCount = tag.team_ids?.length ?? 0;
  const limit = teamCount ? ` · limited to ${teamCount} team${teamCount === 1 ? '' : 's'}` : '';
  if (tag.all_sites) return `All sites${limit}`;
  const names = tag.site_ids
    .map((id) => sites.find((s) => s.id === id)?.name)
    .filter((n): n is string => !!n);
  return (names.length ? names.join(', ') : 'No site') + limit;
}

export function TagsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setStoreTags = useAppStore((s) => s.setTags);
  const sites = useAppStore((s) => s.sites);
  const teams = useAppStore((s) => s.teams);

  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline tag edit (name, color, sites)
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState(DEFAULT_TAG_COLOR);
  const [editAllSites, setEditAllSites] = useState(true);
  const [editSiteIds, setEditSiteIds] = useState<number[]>([]);
  const [editTeamIds, setEditTeamIds] = useState<number[]>([]);

  // Add form
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLOR);

  // One write of each kind at a time (Enter twice would send two writes)
  const tagAdd = useSubmitGuard();
  const editSave = useSubmitGuard();

  // Load the list, and keep the store (project dialogs, Gantt colours) in sync
  const load = useCallback(async () => {
    try {
      const tagData = await tagsApi.getAll();
      setTags(tagData);
      setStoreTags(tagData);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load tags'));
    } finally {
      setIsLoading(false);
    }
  }, [setStoreTags]);

  useEffect(() => {
    load();
  }, [load]);

  const sortedTags = useMemo(
    () => [...tags].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [tags]
  );

  // Unsaved input: a changed inline edit, or a typed new tag name
  const editedTag = editingTagId !== null ? tags.find((t) => t.id === editingTagId) : undefined;
  const tagEditDirty =
    !!editedTag &&
    (editTagName !== editedTag.name ||
      editTagColor !== editedTag.color ||
      editAllSites !== editedTag.all_sites ||
      (!editAllSites && !sameIds(editSiteIds, editedTag.site_ids)) ||
      !sameIds(editTeamIds, editedTag.team_ids ?? []));
  useReportDirty(onDirtyChange, tagEditDirty || newTagName.trim() !== '');

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
    await load();
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    if (!tagAdd.begin()) return;
    try {
      await run(async () => {
        await tagsApi.create({
          name: newTagName.trim(),
          color: newTagColor,
          all_sites: true,
        });
        setNewTagName('');
      }, 'Failed to add tag');
    } finally {
      tagAdd.end();
    }
  };

  const startEditingTag = (tag: Tag) => {
    setEditingTagId(tag.id);
    setEditTagName(tag.name);
    setEditTagColor(tag.color);
    setEditAllSites(tag.all_sites);
    setEditSiteIds(tag.site_ids);
    setEditTeamIds(tag.team_ids ?? []);
  };

  // Sites the edited tag applies to; each may be limited to some of its teams.
  const sitesInScope = editAllSites ? sites : sites.filter((s) => editSiteIds.includes(s.id));

  const canSaveTag = editTagName.trim() !== '' && (editAllSites || editSiteIds.length > 0);

  const handleSaveTag = async (tag: Tag) => {
    if (!canSaveTag) return;
    if (!editSave.begin()) return;
    try {
      await run(async () => {
        await tagsApi.update(tag.id, {
          name: editTagName.trim(),
          color: editTagColor,
          all_sites: editAllSites,
          site_ids: editAllSites ? [] : editSiteIds,
          team_ids: teamIdsWithinSites(editTeamIds, teams, sitesInScope.map((s) => s.id)),
        });
        setEditingTagId(null);
      }, 'Failed to update tag');
    } finally {
      editSave.end();
    }
  };

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>, tag: Tag) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveTag(tag);
    } else if (e.key === 'Escape') {
      // Cancel the inline edit without closing the Settings hub
      e.stopPropagation();
      setEditingTagId(null);
    }
  };

  const handleDeleteTag = async (tag: Tag) => {
    const confirmed = await confirmAction({
      title: 'Delete tag',
      message: `Delete the tag "${tag.name}"? The tag is removed from every project.`,
      destructive: true,
    });
    if (!confirmed) return;
    return run(() => tagsApi.delete(tag.id), 'Failed to delete tag');
  };

  const tagDrag = useDragReorder((draggedId, targetId, position) => {
    const order = moveId(
      sortedTags.map((t) => t.id),
      draggedId,
      targetId,
      position
    );
    // Show the new order right away, then persist
    const rank = new Map(order.map((id, index) => [id, index]));
    setTags((prev) => prev.map((t) => ({ ...t, sort_order: rank.get(t.id) ?? t.sort_order })));
    run(() => tagsApi.reorder(order), 'Failed to reorder tags');
  }, DRAG_CLASSES);

  const renderTag = (tag: Tag) => {
    const isEditing = editingTagId === tag.id;
    return (
      <div
        key={tag.id}
        className={`${styles.item} ${tagDrag.rowClass(tag.id)}`}
        data-testid={`tag-${tag.id}`}
        {...tagDrag.rowProps(tag.id, !isEditing)}
      >
        <div className={styles.mainRow}>
          <span className={styles.dragHandle} aria-hidden="true">
            <Icon icon={DragHandleIcon} size={16} />
          </span>
          <span
            className={styles.colorDot}
            style={{ background: isEditing ? editTagColor : tag.color }}
          />
          <div className={styles.name}>
            {isEditing ? (
              <input
                className={styles.input}
                value={editTagName}
                onChange={(e) => setEditTagName(e.target.value)}
                onKeyDown={(e) => handleTagKeyDown(e, tag)}
                aria-label="Tag name"
                autoFocus
              />
            ) : (
              <span>{tag.name}</span>
            )}
          </div>
          {!isEditing && <span className={styles.sites}>{siteSummary(tag, sites)}</span>}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => (isEditing ? setEditingTagId(null) : startEditingTag(tag))}
              title="Edit name, color and sites"
              aria-label={`Edit ${tag.name}`}
            >
              <Icon icon={EditIcon} size={15} />
            </button>
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.danger}`}
              onClick={() => void handleDeleteTag(tag)}
              title="Delete"
              aria-label={`Delete ${tag.name}`}
            >
              <Icon icon={TrashIcon} size={15} />
            </button>
          </div>
        </div>
        {isEditing && (
          <div className={styles.editRow}>
            <ColorSwatchPicker
              value={editTagColor}
              onChange={setEditTagColor}
              label={`Color of ${tag.name}`}
              allowCustom
            />
            <div className={styles.sitesEdit}>
              <ToggleSwitch checked={editAllSites} onChange={setEditAllSites} label="All sites" />
              {!editAllSites && (
                <SiteChecklist
                  sites={sites}
                  selected={editSiteIds}
                  onChange={setEditSiteIds}
                  label={`Sites of ${tag.name}`}
                />
              )}
              {!editAllSites && editSiteIds.length === 0 && (
                <span className={styles.hint}>Pick at least one site.</span>
              )}
              {sitesInScope.map((s) => (
                <TeamScope
                  key={s.id}
                  site={s}
                  teams={teams}
                  selected={editTeamIds}
                  onChange={setEditTeamIds}
                  multiSite={sitesInScope.length > 1}
                />
              ))}
            </div>
            <div className={styles.editActions}>
              <Button variant="secondary" onClick={() => setEditingTagId(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => handleSaveTag(tag)}
                disabled={!canSaveTag || editSave.isSubmitting}
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (isLoading) {
    return <div className={styles.empty}>Loading tags...</div>;
  }

  return (
    <div className={styles.container}>
      <p className={styles.description}>
        Tags label projects for filtering, for all sites or only some. Drag to reorder. Categories
        such as a project type are dropdown fields in Project fields.
      </p>

      {error && (
        <Notice tone="error">{error}</Notice>
      )}

      <section className={styles.block} aria-label="Tags">
        {tags.length === 0 ? (
          <div className={`${styles.list} ${styles.empty}`}>No tags yet. Add one below.</div>
        ) : (
          <div className={styles.list}>{sortedTags.map(renderTag)}</div>
        )}
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            handleAddTag();
          }}
        >
          <div className={styles.addRow}>
            <Input
              className={styles.addInput}
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="New tag, e.g. Priority"
              aria-label="New tag name"
            />
            <Button
              type="submit"
              icon={<Icon icon={PlusIcon} />}
              disabled={tagAdd.isSubmitting || !newTagName.trim()}
            >
              {tagAdd.isSubmitting ? 'Adding...' : 'Add tag'}
            </Button>
          </div>
          <ColorSwatchPicker
            value={newTagColor}
            onChange={setNewTagColor}
            label="New tag color"
            allowCustom
          />
        </form>
      </section>
    </div>
  );
}
