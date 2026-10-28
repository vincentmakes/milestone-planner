/**
 * ProjectFieldsPanel (Settings hub > Project fields)
 *
 * The fields every project carries, edited in the project dialog:
 * - Built-in fields: Customer, Sales PM, Volume and Confirmed keep their
 *   place in the dialog; each can get another label instance-wide, and all
 *   but Confirmed can be hidden (Confirmed drives the project status, the
 *   default ordering and the counts). Stored in the settings
 *   `project_field_labels` / `project_fields_hidden`.
 * - Custom fields: text, number, switch, dropdown and multi-select dropdown,
 *   in a drag-reorderable list. The type is fixed at creation. A number
 *   field has a Format, picked as the pattern of 1 (As typed / 1 / 1.0 /
 *   1.00 / 1.000 = decimals null / 0-3) in the add row or the row's edit
 *   form (the pencil, saved with its Save), with a live preview of 12.345:
 *   new values are rounded to it, stored ones shown rounded. Deleting a
 *   field removes every project's value (the confirmation names the count).
 * - Items of the dropdown fields: colour, and like tags, all sites or only
 *   some, per site optionally only some teams. Drag to reorder within the field.
 *
 * Writes need project_fields.manage (admins by default); the server rejects
 * conflicting changes (409) with a message shown inline.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Icon, DragHandleIcon, EditIcon, TrashIcon, PlusIcon, ListIcon } from '@/components/common/Icon';
import { useAppStore } from '@/stores/appStore';
import { projectFieldsApi } from '@/api/endpoints/projectFields';
import { getInstanceSettings, updateSetting } from '@/api/endpoints/settings';
import { EVENT_COLOR_SWATCHES } from '@/utils/colorSwatches';
import { teamIdsWithinSites } from '@/utils/teams';
import { confirmAction } from '@/utils/confirmDialog';
import {
  BUILT_IN_PROJECT_FIELDS,
  MAX_FIELD_LABEL_LENGTH,
  fieldLabelsValue,
  hiddenFieldsValue,
  parseFieldLabels,
  parseHiddenFields,
} from '@/utils/instanceSettings';
import type { BuiltInFieldKey } from '@/utils/instanceSettings';
import {
  FIELD_DECIMALS,
  FIELD_TYPE_LABELS,
  fieldNumberInputText,
  formatFieldNumber,
  isDropdownField,
} from '@/utils/projectFields';
import type { ProjectField, ProjectFieldOption, ProjectFieldType, Site, Team } from '@/types';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { SiteChecklist } from './SiteChecklist';
import { TeamScope } from './TeamScope';
import { useDragReorder, moveId } from './useDragReorder';
import styles from './ProjectFieldsPanel.module.css';

const DEFAULT_ITEM_COLOR = EVENT_COLOR_SWATCHES[5].value;
const DRAG_CLASSES = { dragging: styles.dragging, dropBefore: styles.dropBefore, dropAfter: styles.dropAfter };

/** Hint under the Confirmed row: why it cannot be hidden */
export const CONFIRMED_HINT = 'Confirmed drives the project status, ordering and counts';

const TYPE_OPTIONS: { value: ProjectFieldType; label: string }[] = [
  { value: 'select', label: FIELD_TYPE_LABELS.select },
  { value: 'multiselect', label: FIELD_TYPE_LABELS.multiselect },
  { value: 'text', label: FIELD_TYPE_LABELS.text },
  { value: 'number', label: FIELD_TYPE_LABELS.number },
  { value: 'toggle', label: FIELD_TYPE_LABELS.toggle },
];

/** A number field's format, shown as the pattern of 1 ('1.0' = 1 decimal); '' = as typed (null). */
const FORMAT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'As typed' },
  ...FIELD_DECIMALS.map((d) => ({ value: String(d), label: fieldNumberInputText(1, d) })),
];

/** The preview of the As typed format */
export const FORMAT_AS_TYPED_PREVIEW = 'Values are saved as typed.';
/** After the preview of a format in a field's edit form */
export const FORMAT_EXISTING_NOTE = 'Existing values are not changed, only shown rounded.';

/** The number the preview rounds: 12.345 shows both a cut and a half-up carry */
const PREVIEW_SAMPLE = 12.345;

function decimalsFromChoice(value: string): number | null {
  return value === '' ? null : Number(value);
}

function choiceFromDecimals(decimals: number | null | undefined): string {
  return decimals == null ? '' : String(decimals);
}

/** What a format does, with the field's own rounding: "12.345 is saved and shown as 12.3." */
function formatPreview(decimals: number | null, withExistingNote: boolean): string {
  if (decimals === null) return FORMAT_AS_TYPED_PREVIEW;
  const sample = `${formatFieldNumber(PREVIEW_SAMPLE, null)} is saved and shown as ${formatFieldNumber(PREVIEW_SAMPLE, decimals)}.`;
  return withExistingNote ? `${sample} ${FORMAT_EXISTING_NOTE}` : sample;
}

/** The type pill: "Number · 1.0" for a number field with a format */
function typeBadgeText(field: ProjectField): string {
  const type = FIELD_TYPE_LABELS[field.field_type];
  return field.field_type === 'number' && field.decimals != null
    ? `${type} · ${fieldNumberInputText(1, field.decimals)}`
    : type;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function byOrder<T extends { sort_order: number; id: number }>(a: T, b: T): number {
  return a.sort_order - b.sort_order || a.id - b.id;
}

/** Where an item applies: "All sites" or its site names, plus a team limit */
function itemScopeSummary(item: ProjectFieldOption, sites: Site[]): string {
  const teamCount = item.team_ids?.length ?? 0;
  const limit = teamCount ? ` · limited to ${teamCount} team${teamCount === 1 ? '' : 's'}` : '';
  if (item.all_sites) return `All sites${limit}`;
  const names = item.site_ids
    .map((id) => sites.find((s) => s.id === id)?.name)
    .filter((n): n is string => !!n);
  return (names.length ? names.join(', ') : 'No site') + limit;
}

/** The delete confirmation, naming how many projects lose a value */
function deleteFieldMessage(field: ProjectField, projects: number | null): string {
  const head = `Delete the field "${field.name}"?`;
  if (projects === null) return `${head} Every project's value of it is removed.`;
  if (projects === 0) return `${head} No project holds a value.`;
  return `${head} ${projects} project${projects === 1 ? ' holds a value' : 's hold a value'}; it will be removed.`;
}

type Labels = Partial<Record<BuiltInFieldKey, string>>;

interface ItemEdit {
  optionId: number;
  name: string;
  color: string;
  allSites: boolean;
  siteIds: number[];
  teamIds: number[];
}

export function ProjectFieldsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const setStoreFields = useAppStore((s) => s.setProjectFields);
  const setInstanceSettings = useAppStore((s) => s.setInstanceSettings);
  const sites = useAppStore((s) => s.sites);
  const teams = useAppStore((s) => s.teams);

  const [fields, setFields] = useState<ProjectField[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Built-in fields: the saved settings and the edited copy
  const [savedLabels, setSavedLabels] = useState<Labels>({});
  const [savedHidden, setSavedHidden] = useState<string[]>([]);
  const [labels, setLabels] = useState<Labels>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [builtInSuccess, setBuiltInSuccess] = useState<string | null>(null);

  // Custom fields
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState<ProjectFieldType>('select');
  const [newFieldDecimals, setNewFieldDecimals] = useState('');
  // The field whose edit form is open (the pencil): its name and, for a number field, its format
  const [editingFieldId, setEditingFieldId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDecimals, setEditDecimals] = useState('');
  const [expandedFieldId, setExpandedFieldId] = useState<number | null>(null);

  // Items of the expanded field
  const [itemEdit, setItemEdit] = useState<ItemEdit | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemColor, setNewItemColor] = useState(DEFAULT_ITEM_COLOR);

  // One write of each kind at a time (Enter twice would send two writes)
  const builtInSave = useSubmitGuard();
  const fieldAdd = useSubmitGuard();
  const itemAdd = useSubmitGuard();
  const editSave = useSubmitGuard();

  // Fields with their items, kept in sync with the store (project dialogs)
  const loadFields = useCallback(async () => {
    try {
      const data = await projectFieldsApi.getAll();
      const sorted = [...data].sort(byOrder).map((f) => ({ ...f, options: [...f.options].sort(byOrder) }));
      setFields(sorted);
      setStoreFields(sorted);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load project fields'));
    }
  }, [setStoreFields]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadFields(),
      getInstanceSettings().then((settings) => {
        if (cancelled) return;
        const initialLabels = parseFieldLabels(settings.project_field_labels);
        const initialHidden = parseHiddenFields(settings.project_fields_hidden);
        setSavedLabels(initialLabels);
        setLabels(initialLabels);
        setSavedHidden(initialHidden);
        setHidden(initialHidden);
      }),
    ])
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load settings'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadFields]);

  // ---- Dirty state (one flag for the hub) ----

  const labelsValue = fieldLabelsValue(labels);
  const hiddenValue = hiddenFieldsValue(hidden);
  const builtInDirty = labelsValue !== fieldLabelsValue(savedLabels) || hiddenValue !== hiddenFieldsValue(savedHidden);

  const editedField = editingFieldId !== null ? fields.find((f) => f.id === editingFieldId) : undefined;
  const fieldEditDirty =
    !!editedField &&
    (editName !== editedField.name ||
      (editedField.field_type === 'number' && editDecimals !== choiceFromDecimals(editedField.decimals)));
  const editedItem = useMemo(() => {
    if (!itemEdit) return undefined;
    for (const field of fields) {
      const item = field.options.find((o) => o.id === itemEdit.optionId);
      if (item) return item;
    }
    return undefined;
  }, [fields, itemEdit]);
  const itemDirty =
    !!itemEdit &&
    !!editedItem &&
    (itemEdit.name !== editedItem.name ||
      itemEdit.color !== editedItem.color ||
      itemEdit.allSites !== editedItem.all_sites ||
      (!itemEdit.allSites && !sameIds(itemEdit.siteIds, editedItem.site_ids)) ||
      !sameIds(itemEdit.teamIds, editedItem.team_ids ?? []));
  useReportDirty(
    onDirtyChange,
    builtInDirty || fieldEditDirty || itemDirty || newFieldName.trim() !== '' || newItemName.trim() !== ''
  );

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
    await loadFields();
  };

  // ---- Built-in fields ----

  const toggleShown = (key: BuiltInFieldKey, shown: boolean) => {
    setBuiltInSuccess(null);
    setHidden((prev) => (shown ? prev.filter((k) => k !== key) : [...prev.filter((k) => k !== key), key]));
  };

  const handleSaveBuiltIn = () =>
    builtInSave.guard(async () => {
      setError(null);
      setBuiltInSuccess(null);
      const saved: Record<string, string> = {};
      try {
        if (labelsValue !== fieldLabelsValue(savedLabels)) {
          await updateSetting('project_field_labels', labelsValue);
          saved.project_field_labels = labelsValue;
          setSavedLabels(parseFieldLabels(labelsValue));
        }
        if (hiddenValue !== hiddenFieldsValue(savedHidden)) {
          await updateSetting('project_fields_hidden', hiddenValue);
          saved.project_fields_hidden = hiddenValue;
          setSavedHidden(parseHiddenFields(hiddenValue));
        }
        setBuiltInSuccess('Built-in fields saved');
      } catch (err) {
        setError(errorMessage(err, 'Failed to save the built-in fields'));
      } finally {
        // What reached the server applies to the dialogs and rows right away
        if (Object.keys(saved).length > 0) {
          setInstanceSettings({ ...(useAppStore.getState().instanceSettings ?? {}), ...saved });
        }
      }
    });

  const handleResetBuiltIn = () => {
    setLabels(savedLabels);
    setHidden(savedHidden);
    setBuiltInSuccess(null);
  };

  // ---- Custom fields ----

  const handleAddField = () =>
    fieldAdd.guard(async () => {
      const name = newFieldName.trim();
      if (!name) return;
      await run(async () => {
        const created = await projectFieldsApi.create({
          name,
          field_type: newFieldType,
          ...(newFieldType === 'number' ? { decimals: decimalsFromChoice(newFieldDecimals) } : {}),
        });
        setNewFieldName('');
        setNewFieldDecimals('');
        // A new dropdown opens on its items, ready for the first one
        if (isDropdownField(created)) setExpandedFieldId(created.id);
      }, 'Failed to add field');
    });

  const startEditing = (field: ProjectField) => {
    setEditingFieldId(field.id);
    setEditName(field.name);
    setEditDecimals(choiceFromDecimals(field.decimals));
  };

  // Name and format go in one PUT; a number field always sends its format (null = as typed)
  const handleSaveField = (field: ProjectField) =>
    editSave.guard(async () => {
      const name = editName.trim();
      if (!name) return;
      await run(async () => {
        await projectFieldsApi.update(
          field.id,
          field.field_type === 'number' ? { name, decimals: decimalsFromChoice(editDecimals) } : { name }
        );
        setEditingFieldId(null);
      }, 'Failed to update field');
    });

  const handleEditKeyDown = (e: KeyboardEvent<HTMLElement>, field: ProjectField) => {
    if (e.key === 'Enter' && e.currentTarget instanceof HTMLInputElement) {
      e.preventDefault();
      void handleSaveField(field);
    } else if (e.key === 'Escape') {
      // Cancel the edit without closing the Settings hub
      e.stopPropagation();
      setEditingFieldId(null);
    }
  };

  const handleDeleteField = async (field: ProjectField) => {
    let projects: number | null = null;
    try {
      projects = (await projectFieldsApi.usage(field.id)).projects;
    } catch {
      projects = null;
    }
    const confirmed = await confirmAction({
      title: 'Delete project field',
      message: deleteFieldMessage(field, projects),
      destructive: true,
    });
    if (!confirmed) return;
    if (expandedFieldId === field.id) setExpandedFieldId(null);
    return run(() => projectFieldsApi.remove(field.id), 'Failed to delete field');
  };

  const fieldDrag = useDragReorder((draggedId, targetId, position) => {
    const order = moveId(
      fields.map((f) => f.id),
      draggedId,
      targetId,
      position
    );
    // Show the new order right away, then persist
    setFields((prev) => order.map((id) => prev.find((f) => f.id === id)).filter((f): f is ProjectField => !!f));
    run(() => projectFieldsApi.reorder(order), 'Failed to reorder fields');
  }, DRAG_CLASSES);

  const toggleItems = (field: ProjectField) => {
    setExpandedFieldId((prev) => (prev === field.id ? null : field.id));
    setItemEdit(null);
    setNewItemName('');
  };

  // ---- Items ----

  const handleAddItem = (field: ProjectField) =>
    itemAdd.guard(async () => {
      const name = newItemName.trim();
      if (!name) return;
      await run(async () => {
        await projectFieldsApi.createOption(field.id, { name, color: newItemColor, all_sites: true });
        setNewItemName('');
      }, 'Failed to add item');
    });

  const startEditingItem = (item: ProjectFieldOption) =>
    setItemEdit({
      optionId: item.id,
      name: item.name,
      color: item.color,
      allSites: item.all_sites,
      siteIds: item.site_ids,
      teamIds: item.team_ids ?? [],
    });

  const handleSaveItem = () =>
    editSave.guard(async () => {
      if (!itemEdit) return;
      const inScope = itemEdit.allSites ? sites : sites.filter((s) => itemEdit.siteIds.includes(s.id));
      await run(async () => {
        await projectFieldsApi.updateOption(itemEdit.optionId, {
          name: itemEdit.name.trim(),
          color: itemEdit.color,
          all_sites: itemEdit.allSites,
          site_ids: itemEdit.allSites ? [] : itemEdit.siteIds,
          team_ids: teamIdsWithinSites(itemEdit.teamIds, teams, inScope.map((s) => s.id)),
        });
        setItemEdit(null);
      }, 'Failed to update item');
    });

  const handleDeleteItem = async (field: ProjectField, item: ProjectFieldOption) => {
    const confirmed = await confirmAction({
      title: 'Delete item',
      message: `Delete the item "${item.name}" of "${field.name}"? It is removed from every project.`,
      destructive: true,
    });
    if (!confirmed) return;
    if (itemEdit?.optionId === item.id) setItemEdit(null);
    return run(() => projectFieldsApi.removeOption(item.id), 'Failed to delete item');
  };

  const reorderItems = (field: ProjectField, order: number[]) => {
    const rank = new Map(order.map((id, index) => [id, index]));
    setFields((prev) =>
      prev.map((f) =>
        f.id === field.id
          ? {
              ...f,
              options: f.options
                .map((o) => ({ ...o, sort_order: rank.get(o.id) ?? o.sort_order }))
                .sort(byOrder),
            }
          : f
      )
    );
    run(() => projectFieldsApi.reorderOptions(field.id, order), 'Failed to reorder items');
  };

  if (isLoading) {
    return <div className={styles.empty}>Loading project fields...</div>;
  }

  return (
    <div className={styles.container}>
      <p className={styles.description}>
        Fields every project carries, filled in the project dialog. Rename or hide the built-in
        ones, and add your own. Dropdown items can be limited to some sites and teams. Drag to
        reorder.
      </p>

      {error && <Notice tone="error">{error}</Notice>}

      <section className={styles.block} aria-labelledby="project-fields-builtin">
        <h3 id="project-fields-builtin" className={styles.blockTitle}>
          Built-in fields
        </h3>
        <div className={styles.list}>
          {BUILT_IN_PROJECT_FIELDS.map(({ key, label }) => (
            <BuiltInRow
              key={key}
              fieldKey={key}
              defaultLabel={label}
              label={labels[key] ?? ''}
              shown={!hidden.includes(key)}
              disabled={builtInSave.isSubmitting}
              onLabelChange={(value) => {
                setBuiltInSuccess(null);
                setLabels((prev) => ({ ...prev, [key]: value }));
              }}
              onShownChange={(shown) => toggleShown(key, shown)}
            />
          ))}
        </div>
        {builtInSuccess && <Notice tone="success">{builtInSuccess}</Notice>}
        <div className={styles.saveRow}>
          <span className={styles.hint}>{builtInDirty ? 'You have unsaved changes' : ''}</span>
          {builtInDirty && (
            <Button variant="ghost" onClick={handleResetBuiltIn} disabled={builtInSave.isSubmitting}>
              Reset
            </Button>
          )}
          <Button onClick={handleSaveBuiltIn} disabled={!builtInDirty} loading={builtInSave.isSubmitting}>
            Save Changes
          </Button>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="project-fields-custom">
        <h3 id="project-fields-custom" className={styles.blockTitle}>
          Custom fields
        </h3>
        {fields.length === 0 ? (
          <div className={`${styles.list} ${styles.empty}`}>No custom fields yet. Add one below.</div>
        ) : (
          <div className={styles.list}>
            {fields.map((field) => {
              const isEditing = editingFieldId === field.id;
              const isExpanded = expandedFieldId === field.id;
              const dropdown = isDropdownField(field);
              return (
                <div
                  key={field.id}
                  className={`${styles.item} ${fieldDrag.rowClass(field.id)}`}
                  data-testid={`field-${field.id}`}
                  {...fieldDrag.rowProps(field.id, !isEditing && !isExpanded)}
                >
                  <div className={styles.mainRow}>
                    <span className={styles.dragHandle} aria-hidden="true">
                      <Icon icon={DragHandleIcon} size={16} />
                    </span>
                    <div className={styles.name}>
                      {isEditing ? (
                        <Input
                          className={styles.renameInput}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => handleEditKeyDown(e, field)}
                          aria-label="Field name"
                          maxLength={100}
                          autoFocus
                        />
                      ) : (
                        <span>{field.name}</span>
                      )}
                    </div>
                    <span className={styles.typeBadge}>{typeBadgeText(field)}</span>
                    {dropdown && (
                      <span className={styles.meta}>
                        {field.options.length} item{field.options.length === 1 ? '' : 's'}
                      </span>
                    )}
                    <div className={styles.actions}>
                      {isEditing ? (
                        <>
                          <Button variant="secondary" onClick={() => setEditingFieldId(null)}>
                            Cancel
                          </Button>
                          <Button
                            onClick={() => void handleSaveField(field)}
                            disabled={!editName.trim() || editSave.isSubmitting}
                          >
                            Save
                          </Button>
                        </>
                      ) : (
                        <>
                          {dropdown && (
                            <button
                              type="button"
                              className={`${styles.iconBtn} ${isExpanded ? styles.iconBtnActive : ''}`}
                              onClick={() => toggleItems(field)}
                              title="Items"
                              aria-label={`Items of ${field.name}`}
                              aria-expanded={isExpanded}
                            >
                              <Icon icon={ListIcon} size={15} />
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.iconBtn}
                            onClick={() => startEditing(field)}
                            title={field.field_type === 'number' ? 'Edit name and format' : 'Edit name'}
                            aria-label={`Edit ${field.name}`}
                          >
                            <Icon icon={EditIcon} size={15} />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.danger}`}
                        onClick={() => void handleDeleteField(field)}
                        title="Delete"
                        aria-label={`Delete ${field.name}`}
                      >
                        <Icon icon={TrashIcon} size={15} />
                      </button>
                    </div>
                  </div>
                  {isEditing && field.field_type === 'number' && (
                    <div className={styles.formatEdit}>
                      <Select
                        className={styles.format}
                        label="Format"
                        value={editDecimals}
                        options={FORMAT_OPTIONS}
                        onChange={(e) => setEditDecimals(e.target.value)}
                        onKeyDown={(e) => handleEditKeyDown(e, field)}
                        aria-label={`Format of ${field.name}`}
                      />
                      <p className={styles.hint} aria-live="polite">
                        {formatPreview(decimalsFromChoice(editDecimals), true)}
                      </p>
                    </div>
                  )}
                  {isExpanded && dropdown && (
                    <ItemsEditor
                      field={field}
                      sites={sites}
                      teams={teams}
                      itemEdit={itemEdit}
                      onItemEditChange={setItemEdit}
                      onStartEditing={startEditingItem}
                      onSave={() => void handleSaveItem()}
                      saving={editSave.isSubmitting}
                      onDelete={(item) => void handleDeleteItem(field, item)}
                      onReorder={(order) => reorderItems(field, order)}
                      newItemName={newItemName}
                      onNewItemNameChange={setNewItemName}
                      newItemColor={newItemColor}
                      onNewItemColorChange={setNewItemColor}
                      onAdd={() => void handleAddItem(field)}
                      adding={itemAdd.isSubmitting}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddField();
          }}
        >
          <div className={styles.addRow}>
            <Input
              className={styles.addInput}
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              placeholder="New field, e.g. Budget"
              aria-label="New field name"
              maxLength={100}
            />
            <Select
              className={styles.addType}
              value={newFieldType}
              options={TYPE_OPTIONS}
              onChange={(e) => setNewFieldType(e.target.value as ProjectFieldType)}
              aria-label="Type"
            />
            {newFieldType === 'number' && (
              <Select
                className={styles.format}
                label="Format"
                value={newFieldDecimals}
                options={FORMAT_OPTIONS}
                onChange={(e) => setNewFieldDecimals(e.target.value)}
              />
            )}
            <Button
              type="submit"
              icon={<Icon icon={PlusIcon} />}
              disabled={!newFieldName.trim()}
              loading={fieldAdd.isSubmitting}
            >
              Add field
            </Button>
          </div>
          {newFieldType === 'number' && (
            <p className={styles.hint} aria-live="polite">
              {formatPreview(decimalsFromChoice(newFieldDecimals), false)}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}

// =============================================================================
// BUILT-IN FIELD ROW
// =============================================================================

interface BuiltInRowProps {
  fieldKey: BuiltInFieldKey;
  defaultLabel: string;
  label: string;
  shown: boolean;
  disabled: boolean;
  onLabelChange: (label: string) => void;
  onShownChange: (shown: boolean) => void;
}

function BuiltInRow({ fieldKey, defaultLabel, label, shown, disabled, onLabelChange, onShownChange }: BuiltInRowProps) {
  const hintId = useId();
  const locked = fieldKey === 'confirmed';
  return (
    <div className={styles.builtInRow} data-testid={`builtin-${fieldKey}`}>
      <span className={styles.builtInName}>{defaultLabel}</span>
      <Input
        className={styles.builtInLabel}
        value={label}
        onChange={(e) => onLabelChange(e.target.value)}
        placeholder={defaultLabel}
        aria-label={`Label of ${defaultLabel}`}
        maxLength={MAX_FIELD_LABEL_LENGTH}
        disabled={disabled}
      />
      <ToggleSwitch
        checked={locked || shown}
        onChange={onShownChange}
        label="Shown"
        aria-label={`Show ${defaultLabel}`}
        aria-describedby={locked ? hintId : undefined}
        disabled={disabled || locked}
      />
      {locked && (
        <span id={hintId} className={styles.builtInHint}>
          {CONFIRMED_HINT}
        </span>
      )}
    </div>
  );
}

// =============================================================================
// ITEMS EDITOR
// =============================================================================

interface ItemsEditorProps {
  field: ProjectField;
  sites: Site[];
  teams: Team[];
  itemEdit: ItemEdit | null;
  onItemEditChange: (edit: ItemEdit | null) => void;
  onStartEditing: (item: ProjectFieldOption) => void;
  onSave: () => void;
  saving: boolean;
  onDelete: (item: ProjectFieldOption) => void;
  onReorder: (order: number[]) => void;
  newItemName: string;
  onNewItemNameChange: (name: string) => void;
  newItemColor: string;
  onNewItemColorChange: (color: string) => void;
  onAdd: () => void;
  adding: boolean;
}

function ItemsEditor({
  field,
  sites,
  teams,
  itemEdit,
  onItemEditChange,
  onStartEditing,
  onSave,
  saving,
  onDelete,
  onReorder,
  newItemName,
  onNewItemNameChange,
  newItemColor,
  onNewItemColorChange,
  onAdd,
  adding,
}: ItemsEditorProps) {
  const itemDrag = useDragReorder(
    (draggedId, targetId, position) =>
      onReorder(moveId(field.options.map((o) => o.id), draggedId, targetId, position)),
    DRAG_CLASSES
  );

  const patch = (changes: Partial<ItemEdit>) => itemEdit && onItemEditChange({ ...itemEdit, ...changes });

  // Sites the edited item applies to; each may be limited to some of its teams.
  const sitesInScope = itemEdit
    ? itemEdit.allSites
      ? sites
      : sites.filter((s) => itemEdit.siteIds.includes(s.id))
    : [];
  const canSave = !!itemEdit && itemEdit.name.trim() !== '' && (itemEdit.allSites || itemEdit.siteIds.length > 0);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (canSave) onSave();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onItemEditChange(null);
    }
  };

  return (
    <div className={styles.items} role="group" aria-label={`Items of ${field.name}`}>
      {field.options.length === 0 ? (
        <div className={styles.emptySmall}>No items yet. Add the first one below.</div>
      ) : (
        field.options.map((item) => {
          const isEditing = itemEdit?.optionId === item.id;
          return (
            <div
              key={item.id}
              className={`${styles.item} ${itemDrag.rowClass(item.id)}`}
              data-testid={`item-${item.id}`}
              {...itemDrag.rowProps(item.id, !isEditing)}
            >
              <div className={styles.mainRow}>
                <span className={styles.dragHandle} aria-hidden="true">
                  <Icon icon={DragHandleIcon} size={16} />
                </span>
                <span
                  className={styles.colorDot}
                  style={{ background: isEditing && itemEdit ? itemEdit.color : item.color }}
                />
                <div className={styles.name}>
                  {isEditing && itemEdit ? (
                    <Input
                      className={styles.renameInput}
                      value={itemEdit.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      onKeyDown={handleKeyDown}
                      aria-label="Item name"
                      maxLength={100}
                      autoFocus
                    />
                  ) : (
                    <span>{item.name}</span>
                  )}
                </div>
                {!isEditing && <span className={styles.meta}>{itemScopeSummary(item, sites)}</span>}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => (isEditing ? onItemEditChange(null) : onStartEditing(item))}
                    title="Edit name, color and sites"
                    aria-label={`Edit ${item.name}`}
                  >
                    <Icon icon={EditIcon} size={15} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.danger}`}
                    onClick={() => onDelete(item)}
                    title="Delete"
                    aria-label={`Delete ${item.name}`}
                  >
                    <Icon icon={TrashIcon} size={15} />
                  </button>
                </div>
              </div>
              {isEditing && itemEdit && (
                <div className={styles.editRow}>
                  <ColorSwatchPicker
                    value={itemEdit.color}
                    onChange={(color) => patch({ color })}
                    label={`Color of ${item.name}`}
                    allowCustom
                  />
                  <div className={styles.sitesEdit}>
                    <ToggleSwitch
                      checked={itemEdit.allSites}
                      onChange={(allSites) => patch({ allSites })}
                      label="All sites"
                    />
                    {!itemEdit.allSites && (
                      <SiteChecklist
                        sites={sites}
                        selected={itemEdit.siteIds}
                        onChange={(siteIds) => patch({ siteIds })}
                        label={`Sites of ${item.name}`}
                      />
                    )}
                    {!itemEdit.allSites && itemEdit.siteIds.length === 0 && (
                      <span className={styles.hint}>Pick at least one site.</span>
                    )}
                    {sitesInScope.map((s) => (
                      <TeamScope
                        key={s.id}
                        site={s}
                        teams={teams}
                        selected={itemEdit.teamIds}
                        onChange={(teamIds) => patch({ teamIds })}
                        multiSite={sitesInScope.length > 1}
                      />
                    ))}
                  </div>
                  <div className={styles.editActions}>
                    <Button variant="secondary" onClick={() => onItemEditChange(null)}>
                      Cancel
                    </Button>
                    <Button onClick={onSave} disabled={!canSave || saving}>
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
      <form
        className={styles.addForm}
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
      >
        <div className={styles.addRow}>
          <Input
            className={styles.addInput}
            value={newItemName}
            onChange={(e) => onNewItemNameChange(e.target.value)}
            placeholder="New item, e.g. Internal"
            aria-label={`New item of ${field.name}`}
            maxLength={100}
          />
          <Button
            type="submit"
            icon={<Icon icon={PlusIcon} />}
            disabled={!newItemName.trim()}
            loading={adding}
          >
            Add item
          </Button>
        </div>
        <ColorSwatchPicker
          value={newItemColor}
          onChange={onNewItemColorChange}
          label="New item color"
          allowCustom
        />
      </form>
    </div>
  );
}
