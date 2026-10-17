/**
 * AbsenceTypesPanel (Settings hub > Absence types)
 *
 * Tenant-wide categories of time off (Holidays, Illness, Home Office...).
 * "Counts as unavailable" decides whether an absence of the type reduces
 * capacity in the workload views. Drag to reorder; a type that is in use can't
 * be deleted, only deactivated. Admin only.
 */

import { useState, useEffect, useCallback } from 'react';
import { Notice } from '@/components/common/Notice';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { absenceTypesApi } from '@/api';
import { EVENT_COLOR_SWATCHES } from '@/utils/colorSwatches';
import type { AbsenceType } from '@/types';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { DragHandleIcon, EditIcon, TrashIcon, PlusIcon } from './PanelIcons';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import styles from './AbsenceTypesPanel.module.css';

const DEFAULT_TYPE_COLOR = EVENT_COLOR_SWATCHES[6].value;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function AbsenceTypesPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setAbsenceTypes = useAppStore((s) => s.setAbsenceTypes);

  const [types, setTypes] = useState<AbsenceType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline edit of name + color
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(DEFAULT_TYPE_COLOR);

  // Add form
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_TYPE_COLOR);
  const [newUnavailable, setNewUnavailable] = useState(true);
  // One add / one inline save at a time (Enter twice would send two writes)
  const { isSubmitting: isAdding, begin: beginAdd, end: endAdd } = useSubmitGuard();
  const { isSubmitting: isSavingEdit, begin: beginEdit, end: endEdit } = useSubmitGuard();

  // Drag state
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after' | null>(null);

  // Load the types, and keep the store (used by the vacation views) in sync
  const loadTypes = useCallback(async () => {
    try {
      const data = await absenceTypesApi.getAll();
      const sorted = [...data].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      setTypes(sorted);
      setAbsenceTypes(sorted);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load absence types'));
    } finally {
      setIsLoading(false);
    }
  }, [setAbsenceTypes]);

  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  // Unsaved input: a changed inline edit, or a typed new type name
  const editedType = editingId !== null ? types.find((t) => t.id === editingId) : undefined;
  useReportDirty(
    onDirtyChange,
    (!!editedType && (editName !== editedType.name || editColor !== editedType.color)) ||
      newName.trim() !== ''
  );

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
    await loadTypes();
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    if (!beginAdd()) return;
    try {
      await run(async () => {
        await absenceTypesApi.create({
          name: newName.trim(),
          color: newColor,
          counts_as_unavailable: newUnavailable,
        });
        setNewName('');
      }, 'Failed to add absence type');
    } finally {
      endAdd();
    }
  };

  const startEditing = (type: AbsenceType) => {
    setEditingId(type.id);
    setEditName(type.name);
    setEditColor(type.color);
  };

  const handleSaveEdit = async (type: AbsenceType) => {
    if (!editName.trim()) return;
    if (!beginEdit()) return;
    try {
      await run(async () => {
        await absenceTypesApi.update(type.id, { name: editName.trim(), color: editColor });
        setEditingId(null);
      }, 'Failed to update absence type');
    } finally {
      endEdit();
    }
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>, type: AbsenceType) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit(type);
    } else if (e.key === 'Escape') {
      // Cancel the inline edit without closing the Settings hub
      e.stopPropagation();
      setEditingId(null);
    }
  };

  const handleToggle = (type: AbsenceType, field: 'counts_as_unavailable' | 'is_active') =>
    run(
      () =>
        absenceTypesApi.update(
          type.id,
          field === 'is_active'
            ? { is_active: !type.is_active }
            : { counts_as_unavailable: !type.counts_as_unavailable }
        ),
      'Failed to update absence type'
    );

  const handleDelete = async (type: AbsenceType) => {
    if (!window.confirm(`Delete the absence type "${type.name}"?`)) return;
    setError(null);
    try {
      await absenceTypesApi.remove(type.id);
    } catch (err) {
      const message = errorMessage(err, '');
      setError(
        /in use|409/i.test(message)
          ? `"${type.name}" is in use — deactivate it instead.`
          : message || 'Failed to delete absence type'
      );
    }
    await loadTypes();
  };

  // Drag to reorder (same interaction as Predefined phases)
  const resetDrag = () => {
    setDraggedId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (draggedId === id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDragOverId(id);
    setDragOverPosition(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedId || !dragOverId || draggedId === dragOverId) {
      resetDrag();
      return;
    }
    const order = types.map((t) => t.id);
    order.splice(order.indexOf(draggedId), 1);
    let dropIndex = order.indexOf(dragOverId);
    if (dragOverPosition === 'after') dropIndex += 1;
    order.splice(dropIndex, 0, draggedId);
    resetDrag();

    // Show the new order right away, then persist
    setTypes((prev) =>
      order
        .map((id) => prev.find((t) => t.id === id))
        .filter((t): t is AbsenceType => t !== undefined)
    );
    await run(() => absenceTypesApi.reorder(order), 'Failed to reorder absence types');
  };

  return (
    <div className={styles.container}>
      <p className={styles.description}>
        Absence types categorize staff time off for all sites. Types that{' '}
        <strong>count as unavailable</strong> (holidays, illness...) reduce capacity in the
        workload views; available ones (e.g. Home Office) are shown on the timeline but don't
        reduce capacity. Drag to reorder.
      </p>

      {error && <Notice tone="error">{error}</Notice>}

      <div className={styles.list}>
        {isLoading ? (
          <div className={styles.empty}>Loading absence types...</div>
        ) : types.length === 0 ? (
          <div className={styles.empty}>No absence types yet. Add one below.</div>
        ) : (
          types.map((type) => {
            const isEditing = editingId === type.id;
            const rowClass = [
              styles.item,
              !type.is_active ? styles.inactive : '',
              draggedId === type.id ? styles.dragging : '',
              dragOverId === type.id && dragOverPosition === 'before' ? styles.dropBefore : '',
              dragOverId === type.id && dragOverPosition === 'after' ? styles.dropAfter : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={type.id}
                className={rowClass}
                draggable={!isEditing}
                onDragStart={(e) => {
                  setDraggedId(type.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => handleDragOver(e, type.id)}
                onDragLeave={() => {
                  setDragOverId(null);
                  setDragOverPosition(null);
                }}
                onDrop={handleDrop}
                onDragEnd={resetDrag}
              >
                <div className={styles.mainRow}>
                  <span className={styles.dragHandle} aria-hidden="true">
                    <DragHandleIcon />
                  </span>
                  <span
                    className={styles.colorDot}
                    style={{ background: isEditing ? editColor : type.color }}
                  />
                  <div className={styles.name}>
                    {isEditing ? (
                      <input
                        className={styles.input}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(e, type)}
                        aria-label="Absence type name"
                        autoFocus
                      />
                    ) : (
                      <span>{type.name}</span>
                    )}
                    {!type.is_active && !isEditing && (
                      <span className={styles.inactiveBadge}>Inactive</span>
                    )}
                  </div>
                  <ToggleSwitch
                    className={styles.toggleLabel}
                    checked={type.counts_as_unavailable}
                    onChange={() => handleToggle(type, 'counts_as_unavailable')}
                    label="Counts as unavailable"
                  />
                  <ToggleSwitch
                    className={styles.toggleLabel}
                    checked={type.is_active}
                    onChange={() => handleToggle(type, 'is_active')}
                    label="Active"
                  />
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => (isEditing ? setEditingId(null) : startEditing(type))}
                      title="Edit name and color"
                      aria-label={`Edit ${type.name}`}
                    >
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.danger}`}
                      onClick={() => handleDelete(type)}
                      title="Delete"
                      aria-label={`Delete ${type.name}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
                {isEditing && (
                  <div className={styles.editRow}>
                    <ColorSwatchPicker
                      value={editColor}
                      onChange={setEditColor}
                      label={`Color of ${type.name}`}
                      allowCustom
                    />
                    <div className={styles.editActions}>
                      <Button variant="secondary" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                      <Button onClick={() => handleSaveEdit(type)} disabled={!editName.trim() || isSavingEdit}>
                        Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        className={styles.addForm}
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
      >
        <div className={styles.addRow}>
          <Input
            className={styles.addInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New absence type, e.g. Parental leave"
            aria-label="New absence type name"
          />
          <ToggleSwitch
            checked={newUnavailable}
            onChange={setNewUnavailable}
            label="Counts as unavailable"
          />
          <Button type="submit" icon={<PlusIcon />} disabled={isAdding || !newName.trim()}>
            {isAdding ? 'Adding...' : 'Add type'}
          </Button>
        </div>
        <ColorSwatchPicker value={newColor} onChange={setNewColor} label="New absence type color" allowCustom />
      </form>
    </div>
  );
}
