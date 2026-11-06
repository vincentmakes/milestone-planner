/**
 * ProjectFieldsPreview (Settings hub > Project fields)
 *
 * A card beside the field list showing what the settings make of a sample
 * project (`utils/projectFieldsPreview.ts`), switched between:
 * - Gantt details: the Shift-hover details of a project bar, the same
 *   `DetailsRows` and `projectTooltipData` the real tooltip uses;
 * - Project dialog: the dialog's field section as disabled shared controls,
 *   with the visible built-in fields and every custom field.
 * `settings` carries the labels being typed, so a rename shows at once. The
 * card body is a picture: `aria-hidden` and nothing in it is focusable.
 */

import { useMemo, useState } from 'react';
import { Input } from '@/components/common/Input';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { DetailsRows, projectTooltipData } from '@/components/gantt/ShiftTooltip';
import tooltipStyles from '@/components/gantt/ShiftTooltip/ShiftTooltip.module.css';
import { NumberFieldInput, ProjectFieldInputs } from '@/components/modals/ProjectFieldInputs';
import { useAppStore } from '@/stores/appStore';
import {
  builtInFieldLabel,
  isBuiltInFieldHidden,
  selectWeekendsWorking,
  tooltipRowGate,
  volumeDecimals,
} from '@/utils/instanceSettings';
import { draftFromValue, fieldNumberInputText } from '@/utils/projectFields';
import type { FieldDraft } from '@/utils/projectFields';
import { sampleProject } from '@/utils/projectFieldsPreview';
import { barTextColor } from '@/utils/tags';
import type { InstanceSettings, Project, ProjectField, ProjectFieldOption } from '@/types';
import styles from './ProjectFieldsPreview.module.css';

export type PreviewView = 'dialog' | 'gantt';

const VIEWS: ReadonlyArray<{ value: PreviewView; label: string }> = [
  { value: 'dialog', label: 'Project dialog' },
  { value: 'gantt', label: 'Gantt details' },
];

interface ProjectFieldsPreviewProps {
  /** The stored settings with the labels being typed merged in */
  settings: InstanceSettings | null;
  fields: readonly ProjectField[];
}

const NOOP = () => {};

export function ProjectFieldsPreview({ settings, fields }: ProjectFieldsPreviewProps) {
  const [view, setView] = useState<PreviewView>('gantt');
  const storeTags = useAppStore((s) => s.tags);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const project = useMemo(() => sampleProject(fields, storeTags), [fields, storeTags]);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Preview</span>
        <div className={styles.chips} role="group" aria-label="Preview of">
          {VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.chip} ${view === option.value ? styles.activeChip : ''}`}
              aria-pressed={view === option.value}
              onClick={() => setView(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.body} aria-hidden="true" data-testid="pf-preview-body">
        {view === 'gantt' ? (
          <GanttDetailsPreview
            project={project}
            settings={settings}
            fields={fields}
            bankHolidayDates={bankHolidayDates}
          />
        ) : (
          <ProjectDialogPreview project={project} settings={settings} fields={fields} />
        )}
      </div>
      <p className={styles.note}>Sample values. What you switch here is what everyone sees.</p>
    </div>
  );
}

function GanttDetailsPreview({
  project,
  settings,
  fields,
  bankHolidayDates,
}: {
  project: Project;
  settings: InstanceSettings | null;
  fields: readonly ProjectField[];
  bankHolidayDates: ReadonlySet<string>;
}) {
  const storeTags = useAppStore((s) => s.tags);
  const weekendsWorking = useAppStore(selectWeekendsWorking);
  const data = useMemo(
    () => projectTooltipData(project, { tags: storeTags, fields, bankHolidayDates, weekendsWorking }),
    [project, storeTags, fields, bankHolidayDates, weekendsWorking]
  );
  const shows = useMemo(() => tooltipRowGate(settings), [settings]);
  if (!data) return null;
  return (
    <div className={`${tooltipStyles.tooltip} ${tooltipStyles.static}`} data-testid="pf-preview-gantt">
      <DetailsRows data={data} settings={settings} shows={shows} />
    </div>
  );
}

function ProjectDialogPreview({
  project,
  settings,
  fields,
}: {
  project: Project;
  settings: InstanceSettings | null;
  fields: readonly ProjectField[];
}) {
  const storeTags = useAppStore((s) => s.tags);
  // No site scoping in a preview: every item is on offer
  const optionsByField = useMemo(
    () => new Map<number, ProjectFieldOption[]>(fields.map((f) => [f.id, f.options])),
    [fields]
  );
  const drafts = useMemo(() => {
    const out: Record<number, FieldDraft> = {};
    for (const field of fields) out[field.id] = draftFromValue(field, project.field_values?.[field.id]);
    return out;
  }, [fields, project]);
  const tags = useMemo(() => {
    const ids = new Set((project.tags ?? []).map((t) => t.id));
    return storeTags.filter((t) => ids.has(t.id));
  }, [project, storeTags]);

  return (
    <div className={styles.dialog} data-testid="pf-preview-dialog">
      <Input label="Project Manager" value={project.pm_name ?? ''} onChange={NOOP} disabled />
      {!isBuiltInFieldHidden(settings, 'customer') && (
        <Input label={builtInFieldLabel(settings, 'customer')} value={project.customer ?? ''} onChange={NOOP} disabled />
      )}
      {!isBuiltInFieldHidden(settings, 'sales_pm') && (
        <Input label={builtInFieldLabel(settings, 'sales_pm')} value={project.sales_pm ?? ''} onChange={NOOP} disabled />
      )}
      {!isBuiltInFieldHidden(settings, 'volume') && (
        <NumberFieldInput
          label={builtInFieldLabel(settings, 'volume')}
          decimals={volumeDecimals(settings)}
          value={fieldNumberInputText(project.volume ?? 0, volumeDecimals(settings))}
          onChange={NOOP}
          disabled
        />
      )}
      <ProjectFieldInputs
        fields={fields}
        optionsByField={optionsByField}
        drafts={drafts}
        onChange={NOOP}
        disabled
        manageLink={false}
        columns={1}
      />
      <ToggleSwitch checked onChange={NOOP} label={builtInFieldLabel(settings, 'confirmed')} disabled />
      <div className={styles.tags}>
        <span className={styles.tagsLabel}>Tags</span>
        <div className={styles.tagRow}>
          {tags.length === 0 ? (
            <span className={styles.noTags}>No tags</span>
          ) : (
            tags.map((tag) => (
              <span
                key={tag.id}
                className={styles.tagPill}
                style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}
              >
                {tag.name}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
