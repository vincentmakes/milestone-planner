/**
 * TagPicker - select project tags with inline CRUD (admin/superuser only).
 *
 * Flow:
 * - Type a name to filter the dropdown of available tags.
 * - Click an existing tag (or press Enter on a unique match) to attach it.
 * - When no tag matches the typed name, a "Create 'X'" row creates one
 *   instantly with a default color; the dropdown then shows a color-only
 *   picker so you can recolor the just-created tag.
 * - Pencil icon on an existing tag opens an inline name + color editor.
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { tagsApi } from '@/api/endpoints/tags';
import { Button } from '@/components/common/Button';
import type { Tag } from '@/types';
import styles from './TagPicker.module.css';

const PRESET_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
];

const pickRandomColor = () =>
  PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];

interface TagPickerProps {
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
}

export function TagPicker({ selectedIds, onChange }: TagPickerProps) {
  const tags = useAppStore((s) => s.tags);
  const setTags = useAppStore((s) => s.setTags);
  const currentUser = useAppStore((s) => s.currentUser);
  const canManage = currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  // Tag we just created — show a color picker for it
  const [customizing, setCustomizing] = useState<Tag | null>(null);
  // Existing tag being edited via the pencil icon
  const [editing, setEditing] = useState<Tag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown / panels on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomizing(null);
        setEditing(null);
        setError(null);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const tagById = useMemo(() => {
    const m = new Map<number, Tag>();
    tags.forEach((t) => m.set(t.id, t));
    return m;
  }, [tags]);

  const selectedTags = useMemo(
    () => Array.from(selectedIds).map((id) => tagById.get(id)).filter(Boolean) as Tag[],
    [selectedIds, tagById]
  );

  const trimmedSearch = search.trim();

  const filteredTags = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    return tags
      .filter((t) => !selectedIds.has(t.id))
      .filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [tags, selectedIds, trimmedSearch]);

  const exactMatch = useMemo(
    () => tags.find((t) => t.name.toLowerCase() === trimmedSearch.toLowerCase()),
    [tags, trimmedSearch]
  );

  const showCreateRow = canManage && trimmedSearch.length > 0 && !exactMatch;

  const removeFromSelection = (tagId: number) => {
    const next = new Set(selectedIds);
    next.delete(tagId);
    onChange(next);
  };

  const addToSelection = (tag: Tag) => {
    const next = new Set(selectedIds);
    next.add(tag.id);
    onChange(next);
    setSearch('');
  };

  const createTag = async () => {
    if (!trimmedSearch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await tagsApi.create({
        name: trimmedSearch,
        color: pickRandomColor(),
      });
      const all = await tagsApi.getAll();
      setTags(all);
      addToSelection(created);
      setCustomizing(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tag');
    } finally {
      setBusy(false);
    }
  };

  const updateTagColor = async (tag: Tag, color: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await tagsApi.update(tag.id, { color });
      const all = await tagsApi.getAll();
      setTags(all);
      // Keep the panel open with the new color reflected
      if (customizing?.id === tag.id) setCustomizing(updated);
      if (editing?.id === tag.id) setEditing(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update color');
    } finally {
      setBusy(false);
    }
  };

  const renameTag = async (tag: Tag, name: string) => {
    if (!name.trim() || name === tag.name) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await tagsApi.update(tag.id, { name: name.trim() });
      const all = await tagsApi.getAll();
      setTags(all);
      if (editing?.id === tag.id) setEditing(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename tag');
    } finally {
      setBusy(false);
    }
  };

  const deleteTag = async (tag: Tag) => {
    if (!window.confirm(`Delete tag "${tag.name}"? It will be removed from all projects.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await tagsApi.delete(tag.id);
      const all = await tagsApi.getAll();
      setTags(all);
      removeFromSelection(tag.id);
      setEditing(null);
      setCustomizing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tag');
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (exactMatch && !selectedIds.has(exactMatch.id)) {
        addToSelection(exactMatch);
      } else if (showCreateRow) {
        void createTag();
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setCustomizing(null);
      setEditing(null);
    }
  };

  // The "active" panel takes over the dropdown body when set
  const activePanel = customizing
    ? { kind: 'customize' as const, tag: customizing }
    : editing
      ? { kind: 'edit' as const, tag: editing }
      : null;

  return (
    <div className={styles.container} ref={containerRef}>
      {/* Selected pills */}
      <div className={styles.selectedRow}>
        {selectedTags.length === 0 ? (
          <span className={styles.empty}>No tags</span>
        ) : (
          selectedTags.map((tag) => (
            <span
              key={tag.id}
              className={styles.pill}
              style={{ backgroundColor: tag.color }}
            >
              {tag.name}
              <button
                type="button"
                className={styles.pillRemove}
                onClick={() => removeFromSelection(tag.id)}
                aria-label={`Remove ${tag.name}`}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {/* Search + dropdown */}
      <div className={styles.searchWrapper}>
        <input
          type="text"
          className={styles.searchInput}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
            setCustomizing(null);
            setEditing(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={canManage ? 'Find or create a tag...' : 'Find a tag...'}
        />
        {open && (
          <div className={styles.dropdown}>
            {activePanel ? (
              activePanel.kind === 'customize' ? (
                <ColorPanel
                  title={`Pick a color for "${activePanel.tag.name}"`}
                  tag={activePanel.tag}
                  busy={busy}
                  error={error}
                  onPick={(c) => updateTagColor(activePanel.tag, c)}
                  onDone={() => {
                    setCustomizing(null);
                    setOpen(false);
                  }}
                />
              ) : (
                <EditPanel
                  tag={activePanel.tag}
                  busy={busy}
                  error={error}
                  onRename={(name) => renameTag(activePanel.tag, name)}
                  onPickColor={(c) => updateTagColor(activePanel.tag, c)}
                  onDelete={() => deleteTag(activePanel.tag)}
                  onDone={() => {
                    setEditing(null);
                    setOpen(false);
                  }}
                />
              )
            ) : (
              <>
                {filteredTags.length === 0 && !showCreateRow && (
                  <div className={styles.empty}>No tags match</div>
                )}
                {filteredTags.map((tag) => (
                  <div
                    key={tag.id}
                    className={styles.dropdownRow}
                    onClick={() => addToSelection(tag)}
                  >
                    <span
                      className={styles.dropdownPill}
                      style={{ backgroundColor: tag.color }}
                    >
                      {tag.name}
                    </span>
                    {canManage && (
                      <span
                        className={styles.dropdownActions}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={styles.iconBtn}
                          onClick={() => {
                            setEditing(tag);
                            setError(null);
                          }}
                          title="Edit tag"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                {showCreateRow && (
                  <div
                    className={styles.createRow}
                    onClick={() => void createTag()}
                    aria-disabled={busy}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    {busy ? 'Creating...' : `Create "${trimmedSearch}"`}
                  </div>
                )}
                {error && <div className={styles.dropdownError}>{error}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ColorPanelProps {
  title: string;
  tag: Tag;
  busy: boolean;
  error: string | null;
  onPick: (color: string) => void;
  onDone: () => void;
}

function ColorPanel({ title, tag, busy, error, onPick, onDone }: ColorPanelProps) {
  return (
    <div className={styles.editForm} onClick={(e) => e.stopPropagation()}>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>{title}</span>
        <span className={styles.panelPreview} style={{ backgroundColor: tag.color }}>
          {tag.name}
        </span>
      </div>
      <div className={styles.colorPalette}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.colorSwatch} ${tag.color === c ? styles.selected : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => onPick(c)}
            disabled={busy}
            title={c}
          />
        ))}
        <input
          type="color"
          value={tag.color}
          onChange={(e) => onPick(e.target.value)}
          className={styles.customColor}
          disabled={busy}
          title="Custom color"
        />
      </div>
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.editFormActions}>
        <Button type="button" onClick={onDone} disabled={busy}>
          Done
        </Button>
      </div>
    </div>
  );
}

interface EditPanelProps {
  tag: Tag;
  busy: boolean;
  error: string | null;
  onRename: (name: string) => void;
  onPickColor: (color: string) => void;
  onDelete: () => void;
  onDone: () => void;
}

function EditPanel({ tag, busy, error, onRename, onPickColor, onDelete, onDone }: EditPanelProps) {
  const [name, setName] = useState(tag.name);

  // Keep local input in sync if the tag is updated underneath us
  useEffect(() => {
    setName(tag.name);
  }, [tag.name]);

  const commitRename = () => {
    if (name.trim() && name !== tag.name) onRename(name);
  };

  return (
    <div className={styles.editForm} onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        className={styles.editNameInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitRename();
          }
        }}
        placeholder="Tag name"
        maxLength={100}
        disabled={busy}
        autoFocus
      />
      <div className={styles.colorPalette}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.colorSwatch} ${tag.color === c ? styles.selected : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => onPickColor(c)}
            disabled={busy}
            title={c}
          />
        ))}
        <input
          type="color"
          value={tag.color}
          onChange={(e) => onPickColor(e.target.value)}
          className={styles.customColor}
          disabled={busy}
          title="Custom color"
        />
      </div>
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.editFormActions}>
        <Button type="button" variant="secondary" onClick={onDelete} disabled={busy}>
          Delete
        </Button>
        <Button type="button" onClick={onDone} disabled={busy}>
          Done
        </Button>
      </div>
    </div>
  );
}
