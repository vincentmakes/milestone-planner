/**
 * TagsPanel (Settings hub > Tags)
 *
 * Tenant-wide project tags and the groups that categorise them. A group can be
 * single-select (a project holds at most one of its tags). Colouring the
 * Gantt project bars by a group is a per-user choice in the Gantt ("Colour
 * by"), not set here. Tags may be limited to some sites. Drag to reorder groups, and tags within their group. Writes
 * are admin only; the server rejects conflicting changes (409) with a message
 * shown inline.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Notice } from '@/components/common/Notice';
import type { DragEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { tagsApi, tagGroupsApi } from '@/api';
import { EVENT_COLOR_SWATCHES } from '@/utils/colorSwatches';
import { teamIdsWithinSites } from '@/utils/teams';
import type { Site, Tag, TagGroup } from '@/types';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { SiteChecklist } from './SiteChecklist';
import { TeamScope } from './TeamScope';
import { DragHandleIcon, EditIcon, TrashIcon, PlusIcon } from './PanelIcons';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { confirmAction } from '@/utils/confirmDialog';
import styles from './TagsPanel.module.css';

const DEFAULT_TAG_COLOR = EVENT_COLOR_SWATCHES[5].value;
/** Select value of "No group" (a <select> value is always a string) */
const NO_GROUP = '';
/** Section key of the ungrouped tags */
const OTHER_SECTION = 'other';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function byOrder<T extends { sort_order: number; id: number }>(a: T, b: T): number {
  return a.sort_order - b.sort_order || a.id - b.id;
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

interface TagSection {
  key: string;
  title: string;
  tags: Tag[];
}

/** Tags per group in group order, then the ungrouped ones ("Other"). */
function buildSections(tags: Tag[], groups: TagGroup[]): TagSection[] {
  const groupIds = new Set(groups.map((g) => g.id));
  const sorted = [...tags].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const sections: TagSection[] = groups.map((group) => ({
    key: String(group.id),
    title: group.name,
    tags: sorted.filter((t) => t.group_id === group.id),
  }));
  const other = sorted.filter((t) => t.group_id === null || !groupIds.has(t.group_id));
  if (other.length > 0 || groups.length === 0) {
    sections.push({ key: OTHER_SECTION, title: groups.length ? 'Other' : 'Tags', tags: other });
  }
  return sections;
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

/**
 * Drag-to-reorder state for one list: before/after the hovered row's midpoint
 * (same interaction as Absence types and Predefined phases). `canDrop` limits
 * drops, e.g. tags to their own group.
 */
function useDragReorder(
  onDrop: (draggedId: number, targetId: number, position: 'before' | 'after') => void,
  canDrop: (draggedId: number, targetId: number) => boolean = () => true
) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [position, setPosition] = useState<'before' | 'after' | null>(null);

  const reset = () => {
    setDraggedId(null);
    setOverId(null);
    setPosition(null);
  };

  const rowProps = (id: number, enabled: boolean) => ({
    draggable: enabled,
    onDragStart: (e: DragEvent) => {
      setDraggedId(id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: DragEvent) => {
      if (draggedId === null || draggedId === id || !canDrop(draggedId, id)) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setOverId(id);
      setPosition(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
    },
    onDragLeave: () => {
      setOverId(null);
      setPosition(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (draggedId !== null && overId !== null && draggedId !== overId && position) {
        onDrop(draggedId, overId, position);
      }
      reset();
    },
    onDragEnd: reset,
  });

  const rowClass = (id: number) =>
    [
      draggedId === id ? styles.dragging : '',
      overId === id && position === 'before' ? styles.dropBefore : '',
      overId === id && position === 'after' ? styles.dropAfter : '',
    ]
      .filter(Boolean)
      .join(' ');

  return { rowProps, rowClass };
}

/** Move `draggedId` before/after `targetId` in `order`. */
function moveId(order: number[], draggedId: number, targetId: number, position: 'before' | 'after') {
  const next = order.filter((id) => id !== draggedId);
  let index = next.indexOf(targetId);
  if (position === 'after') index += 1;
  next.splice(index, 0, draggedId);
  return next;
}

export function TagsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setStoreTags = useAppStore((s) => s.setTags);
  const setStoreGroups = useAppStore((s) => s.setTagGroups);
  const sites = useAppStore((s) => s.sites);
  const teams = useAppStore((s) => s.teams);

  const [tags, setTags] = useState<Tag[]>([]);
  const [groups, setGroups] = useState<TagGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline group edit (name)
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editGroupName, setEditGroupName] = useState('');

  // Inline tag edit (name, color, sites)
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState(DEFAULT_TAG_COLOR);
  const [editAllSites, setEditAllSites] = useState(true);
  const [editSiteIds, setEditSiteIds] = useState<number[]>([]);
  const [editTeamIds, setEditTeamIds] = useState<number[]>([]);

  // Add forms
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupSingle, setNewGroupSingle] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagGroup, setNewTagGroup] = useState(NO_GROUP);
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLOR);

  // One write of each kind at a time (Enter twice would send two writes)
  const groupAdd = useSubmitGuard();
  const tagAdd = useSubmitGuard();
  const editSave = useSubmitGuard();

  // Load both lists, and keep the store (project dialogs, Gantt colours) in sync
  const load = useCallback(async () => {
    try {
      const [tagData, groupData] = await Promise.all([tagsApi.getAll(), tagGroupsApi.getAll()]);
      const sortedGroups = [...groupData].sort(byOrder);
      setTags(tagData);
      setGroups(sortedGroups);
      setStoreTags(tagData);
      setStoreGroups(sortedGroups);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load tags'));
    } finally {
      setIsLoading(false);
    }
  }, [setStoreTags, setStoreGroups]);

  useEffect(() => {
    load();
  }, [load]);

  const sections = useMemo(() => buildSections(tags, groups), [tags, groups]);
  const sectionOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const section of sections) for (const tag of section.tags) map.set(tag.id, section.key);
    return map;
  }, [sections]);

  // A group picked for the new tag may have been deleted since
  const newTagGroupValue = groups.some((g) => String(g.id) === newTagGroup) ? newTagGroup : NO_GROUP;

  const groupOptions = useMemo(
    () => [
      { value: NO_GROUP, label: 'No group' },
      ...groups.map((g) => ({ value: String(g.id), label: g.name })),
    ],
    [groups]
  );

  // Unsaved input: a changed inline edit, or a typed new group / tag name
  const editedGroup = editingGroupId !== null ? groups.find((g) => g.id === editingGroupId) : undefined;
  const editedTag = editingTagId !== null ? tags.find((t) => t.id === editingTagId) : undefined;
  const groupEditDirty = !!editedGroup && editGroupName !== editedGroup.name;
  const tagEditDirty =
    !!editedTag &&
    (editTagName !== editedTag.name ||
      editTagColor !== editedTag.color ||
      editAllSites !== editedTag.all_sites ||
      (!editAllSites && !sameIds(editSiteIds, editedTag.site_ids)) ||
      !sameIds(editTeamIds, editedTag.team_ids ?? []));
  useReportDirty(
    onDirtyChange,
    groupEditDirty || tagEditDirty || newGroupName.trim() !== '' || newTagName.trim() !== ''
  );

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
    await load();
  };

  // ---- Groups ----

  const handleAddGroup = async () => {
    if (!newGroupName.trim()) return;
    if (!groupAdd.begin()) return;
    try {
      await run(async () => {
        await tagGroupsApi.create({ name: newGroupName.trim(), single_select: newGroupSingle });
        setNewGroupName('');
        setNewGroupSingle(false);
      }, 'Failed to add group');
    } finally {
      groupAdd.end();
    }
  };

  const startEditingGroup = (group: TagGroup) => {
    setEditingGroupId(group.id);
    setEditGroupName(group.name);
  };

  const handleSaveGroup = async (group: TagGroup) => {
    if (!editGroupName.trim()) return;
    if (!editSave.begin()) return;
    try {
      await run(async () => {
        await tagGroupsApi.update(group.id, { name: editGroupName.trim() });
        setEditingGroupId(null);
      }, 'Failed to rename group');
    } finally {
      editSave.end();
    }
  };

  const handleGroupKeyDown = (e: KeyboardEvent<HTMLInputElement>, group: TagGroup) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveGroup(group);
    } else if (e.key === 'Escape') {
      // Cancel the inline edit without closing the Settings hub
      e.stopPropagation();
      setEditingGroupId(null);
    }
  };

  const handleSingleSelect = (group: TagGroup, single: boolean) =>
    run(() => tagGroupsApi.update(group.id, { single_select: single }), 'Failed to update group');

  const handleDeleteGroup = async (group: TagGroup) => {
    const confirmed = await confirmAction({
      title: 'Delete tag group',
      message: `Delete the group "${group.name}"? Tags in this group are kept and become ungrouped.`,
      destructive: true,
    });
    if (!confirmed) return;
    return run(() => tagGroupsApi.delete(group.id), 'Failed to delete group');
  };

  const groupDrag = useDragReorder((draggedId, targetId, position) => {
    const order = moveId(
      groups.map((g) => g.id),
      draggedId,
      targetId,
      position
    );
    // Show the new order right away, then persist
    setGroups((prev) =>
      order.map((id) => prev.find((g) => g.id === id)).filter((g): g is TagGroup => !!g)
    );
    run(() => tagGroupsApi.reorder(order), 'Failed to reorder groups');
  });

  // ---- Tags ----

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    if (!tagAdd.begin()) return;
    try {
      await run(async () => {
        await tagsApi.create({
          name: newTagName.trim(),
          color: newTagColor,
          group_id: newTagGroupValue === NO_GROUP ? null : Number(newTagGroupValue),
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
      e.stopPropagation();
      setEditingTagId(null);
    }
  };

  const handleTagGroup = (tag: Tag, value: string) =>
    run(
      () => tagsApi.update(tag.id, { group_id: value === NO_GROUP ? null : Number(value) }),
      'Failed to move tag'
    );

  const handleDeleteTag = async (tag: Tag) => {
    const confirmed = await confirmAction({
      title: 'Delete tag',
      message: `Delete the tag "${tag.name}"? The tag is removed from every project.`,
      destructive: true,
    });
    if (!confirmed) return;
    return run(() => tagsApi.delete(tag.id), 'Failed to delete tag');
  };

  const tagDrag = useDragReorder(
    (draggedId, targetId, position) => {
      // Full order: sections concatenated in display order
      const order = moveId(
        sections.flatMap((s) => s.tags.map((t) => t.id)),
        draggedId,
        targetId,
        position
      );
      const rank = new Map(order.map((id, index) => [id, index]));
      setTags((prev) =>
        prev.map((t) => ({ ...t, sort_order: rank.get(t.id) ?? t.sort_order }))
      );
      run(() => tagsApi.reorder(order), 'Failed to reorder tags');
    },
    // Tags reorder within their group; the group select moves them between groups
    (draggedId, targetId) => sectionOf.get(draggedId) === sectionOf.get(targetId)
  );

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
            <DragHandleIcon />
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
          <Select
            className={styles.groupSelect}
            value={tag.group_id === null ? NO_GROUP : String(tag.group_id)}
            options={groupOptions}
            onChange={(e) => handleTagGroup(tag, e.target.value)}
            aria-label={`Group of ${tag.name}`}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => (isEditing ? setEditingTagId(null) : startEditingTag(tag))}
              title="Edit name, color and sites"
              aria-label={`Edit ${tag.name}`}
            >
              <EditIcon />
            </button>
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.danger}`}
              onClick={() => void handleDeleteTag(tag)}
              title="Delete"
              aria-label={`Delete ${tag.name}`}
            >
              <TrashIcon />
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
        Tags label projects for filtering, for all sites or only some. Group tags into
        categories (e.g. Status, Customer type); in a <strong>single-select</strong> group a
        project holds at most one of its tags. Drag to reorder.
      </p>

      {error && (
        <Notice tone="error">{error}</Notice>
      )}

      {/* Groups */}
      <section className={styles.block} aria-labelledby="tags-panel-groups">
        <h3 id="tags-panel-groups" className={styles.blockTitle}>
          Groups
        </h3>
        <div className={styles.list}>
          {groups.length === 0 ? (
            <div className={styles.empty}>No groups yet. Tags without a group are listed as "Other".</div>
          ) : (
            groups.map((group) => {
              const isEditing = editingGroupId === group.id;
              return (
                <div
                  key={group.id}
                  className={`${styles.item} ${groupDrag.rowClass(group.id)}`}
                  data-testid={`group-${group.id}`}
                  {...groupDrag.rowProps(group.id, !isEditing)}
                >
                  <div className={styles.mainRow}>
                    <span className={styles.dragHandle} aria-hidden="true">
                      <DragHandleIcon />
                    </span>
                    <div className={styles.name}>
                      {isEditing ? (
                        <input
                          className={styles.input}
                          value={editGroupName}
                          onChange={(e) => setEditGroupName(e.target.value)}
                          onKeyDown={(e) => handleGroupKeyDown(e, group)}
                          aria-label="Group name"
                          autoFocus
                        />
                      ) : (
                        <span>{group.name}</span>
                      )}
                    </div>
                    <ToggleSwitch
                      className={styles.toggleLabel}
                      checked={group.single_select}
                      onChange={(checked) => handleSingleSelect(group, checked)}
                      label="Single select"
                      aria-label={`Single select: ${group.name}`}
                    />
                    <div className={styles.actions}>
                      {isEditing ? (
                        <>
                          <Button variant="secondary" onClick={() => setEditingGroupId(null)}>
                            Cancel
                          </Button>
                          <Button
                            onClick={() => handleSaveGroup(group)}
                            disabled={!editGroupName.trim() || editSave.isSubmitting}
                          >
                            Save
                          </Button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.iconBtn}
                          onClick={() => startEditingGroup(group)}
                          title="Rename"
                          aria-label={`Rename ${group.name}`}
                        >
                          <EditIcon />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.danger}`}
                        onClick={() => void handleDeleteGroup(group)}
                        title="Delete"
                        aria-label={`Delete group ${group.name}`}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            handleAddGroup();
          }}
        >
          <div className={styles.addRow}>
            <Input
              className={styles.addInput}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New group, e.g. Status"
              aria-label="New group name"
            />
            <ToggleSwitch checked={newGroupSingle} onChange={setNewGroupSingle} label="Single select" />
            <Button
              type="submit"
              icon={<PlusIcon />}
              disabled={groupAdd.isSubmitting || !newGroupName.trim()}
            >
              {groupAdd.isSubmitting ? 'Adding...' : 'Add group'}
            </Button>
          </div>
        </form>
      </section>

      {/* Tags */}
      <section className={styles.block} aria-labelledby="tags-panel-tags">
        <h3 id="tags-panel-tags" className={styles.blockTitle}>
          Tags
        </h3>
        {tags.length === 0 ? (
          <div className={`${styles.list} ${styles.empty}`}>No tags yet. Add one below.</div>
        ) : (
          sections.map((section) => (
            <div key={section.key} className={styles.section} role="group" aria-label={section.title}>
              <h4 className={styles.sectionTitle}>{section.title}</h4>
              <div className={styles.list}>
                {section.tags.length === 0 ? (
                  <div className={styles.emptySmall}>No tags in this group.</div>
                ) : (
                  section.tags.map(renderTag)
                )}
              </div>
            </div>
          ))
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
            <Select
              className={styles.groupSelect}
              value={newTagGroupValue}
              options={groupOptions}
              onChange={(e) => setNewTagGroup(e.target.value)}
              aria-label="New tag group"
            />
            <Button
              type="submit"
              icon={<PlusIcon />}
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
