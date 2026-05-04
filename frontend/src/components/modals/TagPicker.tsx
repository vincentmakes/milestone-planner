/**
 * TagPicker - select project tags with inline CRUD (admin/superuser only).
 *
 * - Selected tags render as pills (click X to deselect).
 * - Type to filter the dropdown of available tags.
 * - Admins can edit/delete each tag inline, or create a new one from the dropdown.
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

interface TagPickerProps {
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
}

type FormState = { mode: 'edit'; tag: Tag } | { mode: 'create'; name: string } | null;

export function TagPicker({ selectedIds, onChange }: TagPickerProps) {
  const tags = useAppStore((s) => s.tags);
  const setTags = useAppStore((s) => s.setTags);
  const currentUser = useAppStore((s) => s.currentUser);
  const canManage = currentUser?.role === 'admin' || currentUser?.role === 'superuser';

  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setForm(null);
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

  const filteredTags = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tags
      .filter((t) => !selectedIds.has(t.id))
      .filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [tags, selectedIds, search]);

  const showCreateRow =
    canManage &&
    search.trim().length > 0 &&
    !tags.some((t) => t.name.toLowerCase() === search.trim().toLowerCase());

  const toggle = (tagId: number) => {
    const next = new Set(selectedIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    onChange(next);
  };

  const handleSelect = (tag: Tag) => {
    const next = new Set(selectedIds);
    next.add(tag.id);
    onChange(next);
    setSearch('');
  };

  const handleSaved = (saved: Tag) => {
    // Refresh tags list and auto-select the saved tag
    tagsApi.getAll().then((all) => {
      setTags(all);
      const next = new Set(selectedIds);
      next.add(saved.id);
      onChange(next);
    });
    setForm(null);
    setSearch('');
  };

  const handleDeleted = (tagId: number) => {
    tagsApi.getAll().then(setTags);
    const next = new Set(selectedIds);
    next.delete(tagId);
    onChange(next);
    setForm(null);
  };

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
                onClick={() => toggle(tag.id)}
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
          }}
          onFocus={() => setOpen(true)}
          placeholder="Add a tag..."
        />
        {open && (
          <div className={styles.dropdown}>
            {filteredTags.length === 0 && !showCreateRow && (
              <div className={styles.empty}>No tags match</div>
            )}
            {filteredTags.map((tag) => (
              <div
                key={tag.id}
                className={styles.dropdownRow}
                onClick={() => handleSelect(tag)}
              >
                <span className={styles.dropdownPill} style={{ backgroundColor: tag.color }}>
                  {tag.name}
                </span>
                {canManage && (
                  <span className={styles.dropdownActions} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => setForm({ mode: 'edit', tag })}
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
                onClick={() => setForm({ mode: 'create', name: search.trim() })}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create &quot;{search.trim()}&quot;
              </div>
            )}

            {canManage && !showCreateRow && search.trim().length === 0 && (
              <div
                className={styles.createRow}
                onClick={() => setForm({ mode: 'create', name: '' })}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New tag
              </div>
            )}

            {form && (
              <TagEditForm
                state={form}
                onSaved={handleSaved}
                onDeleted={handleDeleted}
                onCancel={() => setForm(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface TagEditFormProps {
  state: NonNullable<FormState>;
  onSaved: (tag: Tag) => void;
  onDeleted: (tagId: number) => void;
  onCancel: () => void;
}

function TagEditForm({ state, onSaved, onDeleted, onCancel }: TagEditFormProps) {
  const initialName = state.mode === 'edit' ? state.tag.name : state.name;
  const initialColor = state.mode === 'edit' ? state.tag.color : PRESET_COLORS[0];

  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const saved = state.mode === 'edit'
        ? await tagsApi.update(state.tag.id, { name: name.trim(), color })
        : await tagsApi.create({ name: name.trim(), color });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tag');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (state.mode !== 'edit') return;
    if (!window.confirm(`Delete tag "${state.tag.name}"? It will be removed from all projects.`)) {
      return;
    }
    setSubmitting(true);
    try {
      await tagsApi.delete(state.tag.id);
      onDeleted(state.tag.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tag');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.editForm} onClick={(e) => e.stopPropagation()}>
      <div className={styles.editFormRow}>
        <input
          type="text"
          className={styles.editNameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tag name"
          maxLength={100}
          autoFocus
        />
      </div>
      <div className={styles.colorPalette}>
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.colorSwatch} ${color === c ? styles.selected : ''}`}
            style={{ backgroundColor: c }}
            onClick={() => setColor(c)}
            title={c}
          />
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className={styles.customColor}
          title="Custom color"
        />
      </div>
      {error && <div className={styles.formError}>{error}</div>}
      <div className={styles.editFormActions}>
        {state.mode === 'edit' && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleDelete}
            disabled={submitting}
          >
            Delete
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Saving...' : state.mode === 'edit' ? 'Save' : 'Create'}
        </Button>
      </div>
    </div>
  );
}
