/**
 * ProjectFieldInputs - the project fields in the project dialog, in field
 * order: text → Input, number → NumberFieldInput (step, typing gate and blur
 * formatting from the field's decimals), toggle → ToggleSwitch,
 * select → Select with an empty choice, multiselect → MultiSelectDropdown
 * (the same box, ticking several items).
 *
 * Dropdowns offer only the items that apply to the project's site and teams
 * (`optionsByField`, computed by the dialog). Holders of
 * project_fields.manage get a "Manage fields…" shortcut to Settings →
 * Project fields, also when no field exists yet.
 */

import { useMemo } from 'react';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { MultiSelectDropdown } from '@/components/common/MultiSelectDropdown';
import { useAppStore } from '@/stores/appStore';
import { can } from '@/utils/permissions';
import { acceptsNumberText, fieldNumberInputText } from '@/utils/projectFields';
import type { FieldDraft } from '@/utils/projectFields';
import type { ProjectField, ProjectFieldOption } from '@/types';
import { ManageSettingsLink } from './ManageSettingsLink';
import styles from './ProjectModal.module.css';

/** Confirmation shown before "Manage fields…" leaves the project dialog. */
export const MANAGE_FIELDS_CONFIRM =
  'Open Settings → Project fields? This closes the dialog and discards unsaved changes.';

/** Longest text value the server accepts */
const MAX_TEXT_LENGTH = 2000;

interface ProjectFieldInputsProps {
  fields: readonly ProjectField[];
  /** Items on offer per field id (those applying to the project's site and teams) */
  optionsByField: ReadonlyMap<number, ProjectFieldOption[]>;
  drafts: Readonly<Record<number, FieldDraft>>;
  onChange: (fieldId: number, draft: FieldDraft) => void;
  disabled?: boolean;
}

const NO_OPTIONS: ProjectFieldOption[] = [];

export function ProjectFieldInputs({ fields, optionsByField, drafts, onChange, disabled = false }: ProjectFieldInputsProps) {
  const canManage = useAppStore((s) => can(s.currentUser, 'project_fields.manage'));
  if (fields.length === 0 && !canManage) return null;

  return (
    <div className={styles.formGroup}>
      {fields.length > 0 && (
        <div className={styles.fieldsGrid}>
          {fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              options={optionsByField.get(field.id) ?? NO_OPTIONS}
              draft={drafts[field.id]}
              onChange={(draft) => onChange(field.id, draft)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      <div className={styles.manageRow}>
        {fields.length === 0 && <span className={styles.hint}>No project fields yet.</span>}
        <ManageSettingsLink
          section="project-fields"
          label="Manage fields…"
          confirmTitle="Manage project fields"
          confirmMessage={MANAGE_FIELDS_CONFIRM}
          blockedAction="Managing project fields"
          permission="project_fields.manage"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

interface FieldInputProps {
  field: ProjectField;
  options: ProjectFieldOption[];
  draft: FieldDraft | undefined;
  onChange: (draft: FieldDraft) => void;
  disabled: boolean;
}

function FieldInput({ field, options, draft, onChange, disabled }: FieldInputProps) {
  const text = typeof draft === 'string' ? draft : '';
  const selectOptions = useMemo(
    () => [{ value: '', label: 'None' }, ...options.map((o) => ({ value: String(o.id), label: o.name }))],
    [options]
  );
  const selectedIds = useMemo(() => new Set(Array.isArray(draft) ? draft : []), [draft]);

  switch (field.field_type) {
    case 'toggle':
      return (
        <div className={styles.fieldToggle}>
          <ToggleSwitch checked={draft === true} onChange={onChange} label={field.name} disabled={disabled} />
        </div>
      );
    case 'number':
      return (
        <NumberFieldInput
          label={field.name}
          decimals={field.decimals ?? null}
          className={styles.field}
          value={text}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'select':
      return (
        <Select
          label={field.name}
          className={styles.field}
          // An item no longer on offer reads as none (it is dropped on save)
          value={options.some((o) => String(o.id) === text) ? text : ''}
          onChange={(e) => onChange(e.target.value)}
          options={selectOptions}
          disabled={disabled}
        />
      );
    case 'multiselect':
      return (
        <MultiSelectDropdown
          label={field.name}
          className={styles.field}
          options={options}
          selectedIds={selectedIds}
          onChange={onChange}
          disabled={disabled}
        />
      );
    default:
      return (
        <Input
          label={field.name}
          type="text"
          className={styles.field}
          value={text}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
  }
}

interface NumberFieldInputProps {
  label: string;
  /** Decimals the value keeps (null = as typed) */
  decimals: number | null;
  /** The input's text ('' = none) */
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * A number with a format (a number project field, the built-in Volume): a
 * keystroke that would add more decimals than it keeps is refused, and blur
 * pads to the format (12 → 12.0). As typed (null) takes anything.
 */
export function NumberFieldInput({
  label,
  decimals,
  value,
  onChange,
  disabled = false,
  placeholder,
  className,
}: NumberFieldInputProps) {
  return (
    <Input
      label={label}
      type="number"
      // 10^-d: the spinner steps by the last kept decimal
      step={decimals === null ? 'any' : String(10 ** -decimals)}
      inputMode="decimal"
      className={`${className ?? ''} ${styles.numberField}`.trim()}
      value={value}
      // Controlled: a refused keystroke never lands
      onChange={(e) => {
        if (acceptsNumberText(e.target.value, decimals)) onChange(e.target.value);
      }}
      onBlur={() => {
        // Shows what will be stored: rounded half-up to the decimals
        const n = value.trim() === '' ? NaN : Number(value);
        if (decimals !== null && Number.isFinite(n)) {
          const formatted = fieldNumberInputText(n, decimals);
          if (formatted !== value) onChange(formatted);
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
