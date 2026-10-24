/**
 * WidgetEditor — add or edit one dashboard widget (2.1.0), with a live
 * preview.
 *
 * The form, in order: the kind (a radio group of nine), the title, the
 * measure (grouped by family; the capacity measures only with `views.staff`,
 * the equipment ones only with `views.equipment` — a stored measure stays
 * listed, the preview then shows the server's refusal), up to two
 * dimensions (only the kinds the measure accepts — the matrix of
 * `utils/metrics.ts`; *Person* only with `views.staff` — on a capacity
 * measure also `absences.view_others`, like the *People* filter —, *Equipment* and
 * *Equipment type* only with `views.equipment`; a project field kind becomes
 * one choice per dropdown or toggle field; a period carries its grain), the
 * filters (a collapsible section, closed when none is set, holding only the
 * filters the measure takes), the period (relative, or custom dates),
 * *Percent of* (not on a measure that takes no percentage) and *Top N*, and
 * the display options of the kind. The kind rules (`widgetDraft.ts`): a KPI
 * has at most one dimension and then shows a share of the total (its
 * *Bucket* is one of the preview's values) — a KPI of utilisation or
 * available days has none —, a pie exactly one, a gauge none (no dimension
 * field, no *Percent of* nor *Top N*; its *Target* in the display options), a
 * heatmap and a sankey two, a treemap one or two (neither of them offers
 * *Period*), the others up to two; changing the measure drops a dimension or
 * a filter it refuses.
 *
 * The preview asks the server (`/dashboards/query`) 400 ms after the last
 * change; a newer request supersedes an older one (answers are matched by a
 * sequence number) and an answer after the dialog closed is dropped. A
 * refusal (422) shows the server's words in the preview and disables Save; a
 * network failure says "Preview unavailable" and leaves Save enabled. Save
 * checks the title and the kind rules, then hands the widget (a new one
 * placed at the bottom of the grid) and its preview to the builder.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import type { SearchableOption } from '@/components/common/SearchableSelect';
import { MultiSelectDropdown } from '@/components/common/MultiSelectDropdown';
import type { MultiSelectDropdownItem } from '@/components/common/MultiSelectDropdown';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { DateRangeField } from '@/components/common/DateRangeField';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import {
  Icon,
  BarChartIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GaugeIcon,
  HeatmapIcon,
  KpiIcon,
  LineChartIcon,
  PieChartIcon,
  SankeyIcon,
  TableIcon,
  TreemapIcon,
} from '@/components/common/Icon';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { useHasPermission } from '@/hooks/useCan';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { uniqueById } from '@/utils/uniqueById';
import {
  DIMENSION_KINDS,
  dimensionLabel,
  dimensionNeeds,
  FILTER_LABELS,
  filterNeeds,
  GRAINS,
  isDimensionHidden,
  isValidDimension,
  measureFamily,
  measureNeeds,
  measuresByFamily,
  NO_PERCENT_MEASURES,
  OTHER_KEY,
  queryUnit,
  RELATIVE_PERIODS,
  takesFilter,
  unitWord,
} from '@/utils/metrics';
import type { FilterKey } from '@/utils/metrics';
import type {
  DimensionKind,
  Grain,
  Measure,
  MetricDimension,
  MetricFilters,
  MetricQuery,
  MetricResult,
  RelativePeriod,
  WidgetKind,
  WidgetOptions,
} from '@/types';
import { WidgetCard } from '../WidgetCard';
import { gaugeTarget } from '../charts/toOption';
import { plainError } from './useDashboardEditor';
import {
  activeFilterCount,
  changeMeasure,
  cleanOptions,
  cleanQuery,
  defaultQuery,
  dimensionKey,
  dropUnheld,
  MAX_DIMENSIONS,
  MIN_DIMENSIONS,
  newClientId,
  noDimensionKind,
  normaliseQuery,
  parseTarget,
  placeNewWidget,
  queryProblem,
  stableKey,
  SUMMED_KINDS,
} from './widgetDraft';
import type { DraftWidget } from './widgetDraft';
import type { PermissionKey } from '@/types/permissions';
import styles from './WidgetEditor.module.css';

/** The preview waits this long after the last change. */
export const PREVIEW_DELAY_MS = 400;
export const PREVIEW_UNAVAILABLE = 'Preview unavailable';
export const TITLE_REQUIRED = 'Enter a title';
export const KPI_BUCKET_REQUIRED = 'A KPI share needs a bucket: choose the value whose share it shows.';
const TITLE_MAX = 120;

const WIDGET_KINDS: readonly { key: WidgetKind; label: string; icon: typeof BarChartIcon }[] = [
  { key: 'kpi', label: 'KPI', icon: KpiIcon },
  { key: 'gauge', label: 'Gauge', icon: GaugeIcon },
  { key: 'bar', label: 'Bar', icon: BarChartIcon },
  { key: 'line', label: 'Line', icon: LineChartIcon },
  { key: 'pie', label: 'Pie', icon: PieChartIcon },
  { key: 'heatmap', label: 'Heatmap', icon: HeatmapIcon },
  { key: 'treemap', label: 'Treemap', icon: TreemapIcon },
  { key: 'sankey', label: 'Sankey', icon: SankeyIcon },
  { key: 'table', label: 'Table', icon: TableIcon },
];

/** Measures whose numbers count working days at the project's site (the hint names the holiday rule). */
const WORKING_DAY_MEASURES: ReadonlySet<Measure> = new Set<Measure>([
  'booked_days',
  'booked_weeks',
  'project_weeks',
  'phase_weeks',
  'equipment_booked_days',
]);
export const WORKING_DAYS_HINT =
  'Working days: Monday to Friday, without the bank holidays loaded for the project’s site.';
export const CAPACITY_HINT =
  'Capacity counts weekdays at the person’s sites minus bank holidays, absences and closures, at their max capacity; booked time is matched to the same people';
export const EQUIPMENT_AVAILABILITY_HINT =
  'Availability counts weekdays at the equipment’s sites minus bank holidays and blocks; overlapping bookings add up';

/** The hint under the measure: how its days are counted. */
function measureHint(measure: Measure): string | undefined {
  if (WORKING_DAY_MEASURES.has(measure)) return WORKING_DAYS_HINT;
  if (measureFamily(measure) === 'capacity') return CAPACITY_HINT;
  if (measure === 'equipment_utilisation') return EQUIPMENT_AVAILABILITY_HINT;
  return undefined;
}

const MILESTONE_OPTIONS = [
  { value: 'include', label: 'Include' },
  { value: 'only', label: 'Only' },
  { value: 'exclude', label: 'Exclude' },
];

/** Picker ids of the dimension choices: a kind by its position, a project field by its id. */
const FIELD_ID_BASE = 1000;
const kindId = (kind: DimensionKind): number => DIMENSION_KINDS.findIndex((d) => d.key === kind) + 1;
const dimensionId = (d: MetricDimension): number => (d.kind === 'field' ? FIELD_ID_BASE + d.field_id : kindId(d.kind));

interface DimensionChoice extends SearchableOption {
  dimension: MetricDimension;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; result: MetricResult | null; key: string | null }
  | { status: 'ok'; result: MetricResult; key: string }
  | { status: 'invalid'; message: string }
  | { status: 'unavailable' };

export interface WidgetEditorProps {
  /** The widget to edit; null adds one */
  widget: DraftWidget | null;
  /** The dashboard's widgets (a new one lands under them) */
  widgets: readonly DraftWidget[];
  onClose: () => void;
  /** The finished widget and its preview (null when none matches it) */
  onSave: (widget: DraftWidget, preview: MetricResult | null) => void;
}

type ListFilter = 'site_ids' | 'team_ids' | 'project_team_ids' | 'person_ids' | 'project_ids' | 'tag_ids' | 'equipment_ids';

const bucketValue = (key: unknown): string => JSON.stringify(key);

export function WidgetEditor({ widget, widgets, onClose, onSave }: WidgetEditorProps) {
  const [kind, setKind] = useState<WidgetKind>(widget?.kind ?? 'bar');
  const [title, setTitle] = useState(widget?.title ?? '');
  const [query, setQuery] = useState<MetricQuery>(() =>
    normaliseQuery(widget?.kind ?? 'bar', {
      ...defaultQuery(),
      ...(widget?.query ?? {}),
      filters: { ...defaultQuery().filters, ...(widget?.query.filters ?? {}) },
    })
  );
  const [options, setOptions] = useState<WidgetOptions>(widget?.options ?? {});
  const [topNText, setTopNText] = useState(widget?.query.top_n ? String(widget.query.top_n) : '');
  // The stored target as text: only one the gauge draws (finite, ≥ 0).
  const [targetText, setTargetText] = useState(() => {
    const target = gaugeTarget(widget?.options.target);
    return target === null ? '' : String(target);
  });
  const [filtersOpen, setFiltersOpen] = useState(() => activeFilterCount(widget?.query.filters) > 0);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const { isSubmitting, begin, end } = useSubmitGuard();
  const filtersId = useId();

  const canStaff = useHasPermission('views.staff');
  const canEquipment = useHasPermission('views.equipment');
  const canArchived = useHasPermission('views.archived');
  const canAbsences = useHasPermission('absences.view_others');
  // The keys a measure, a dimension or a filter may need, as held by the user.
  const heldKeys = useMemo(() => {
    const held = new Set<PermissionKey>();
    if (canStaff) held.add('views.staff');
    if (canEquipment) held.add('views.equipment');
    if (canArchived) held.add('views.archived');
    if (canAbsences) held.add('absences.view_others');
    return held;
  }, [canStaff, canEquipment, canArchived, canAbsences]);
  const holds = (key: PermissionKey | null): boolean => key === null || heldKeys.has(key);
  const fields = useAppStore((s) => s.projectFields);
  const settings = useAppStore((s) => s.instanceSettings);
  const teams = useAppStore((s) => s.teams);
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const tags = useAppStore((s) => s.tags);
  const equipment = useAppStore((s) => s.equipment);
  const sites = useVisibleSites();

  const dimensions = useMemo(() => query.dimensions ?? [], [query.dimensions]);
  const filters = useMemo<MetricFilters>(() => query.filters ?? {}, [query.filters]);
  // The filters the measure takes, and the user may use (People: views.staff, and on a
  // capacity measure absences.view_others; Equipment: views.equipment).
  const showsFilter = (key: FilterKey): boolean =>
    takesFilter(query.measure, key) && holds(filterNeeds(key)) && holds(filterNeeds(key, query.measure));
  const noPercent = NO_PERCENT_MEASURES.has(query.measure);
  // A gauge, and a KPI of a measure that takes no percentage, show the total: no dimension.
  const noDimension = noDimensionKind(kind, query.measure);
  const problem = queryProblem(kind, query);
  const clean = useMemo(() => cleanQuery(query), [query]);
  const previewKey = problem ? null : stableKey(clean);

  // --- The live preview ------------------------------------------------------
  const seqRef = useRef(0);
  const cleanRef = useRef(clean);
  cleanRef.current = clean;
  useEffect(() => {
    const seq = ++seqRef.current;
    if (previewKey === null) {
      setPreview({ status: 'idle' });
      return;
    }
    setPreview((prev) => ({
      status: 'loading',
      result: prev.status === 'ok' || prev.status === 'loading' ? prev.result : null,
      key: prev.status === 'ok' || prev.status === 'loading' ? prev.key : null,
    }));
    const timer = window.setTimeout(() => {
      dashboardsApi.query(cleanRef.current).then(
        (result) => {
          if (seq === seqRef.current) setPreview({ status: 'ok', result, key: previewKey });
        },
        (err: unknown) => {
          if (seq !== seqRef.current) return;
          if (err instanceof ApiError && err.status === 422) {
            setPreview({ status: 'invalid', message: plainError(err, 'This widget cannot be shown.') });
          } else {
            setPreview({ status: 'unavailable' });
          }
        }
      );
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [previewKey]);
  // An answer landing after the dialog closed is dropped.
  useEffect(
    () => () => {
      seqRef.current += 1;
    },
    []
  );

  const previewResult = preview.status === 'ok' || preview.status === 'loading' ? preview.result : null;

  // --- Changes -----------------------------------------------------------------
  const update = (nextKind: WidgetKind, next: MetricQuery) => {
    const normalised = normaliseQuery(nextKind, next);
    setQuery(normalised);
    if (!normalised.top_n) setTopNText('');
  };

  const changeKind = (nextKind: WidgetKind) => {
    setKind(nextKind);
    let next = query;
    // A KPI with a dimension shows a share; a pie needs its one dimension.
    if (nextKind === 'kpi' && dimensions.length > 0) next = { ...next, percent_of: 'total' };
    update(nextKind, next);
  };

  const setDimension = (index: 0 | 1, choice: MetricDimension | null) => {
    const next = [...dimensions];
    if (choice === null) next.splice(index, 1);
    else next[index] = choice;
    const extra: Partial<MetricQuery> = kind === 'kpi' && next.length > 0 ? { percent_of: 'total' } : {};
    update(kind, { ...query, ...extra, dimensions: next });
  };

  const setPercentOf = (value: string) => {
    const percentOf = value === 'total' || value === 'first_dimension' ? value : null;
    // A KPI without a share has no dimension.
    const nextDimensions = kind === 'kpi' && percentOf === null ? [] : dimensions;
    update(kind, { ...query, percent_of: percentOf, dimensions: nextDimensions });
  };

  const setFilters = (patch: Partial<MetricFilters>) => {
    setQuery((prev) => ({ ...prev, filters: { ...(prev.filters ?? {}), ...patch } }));
  };

  const setTopN = (text: string) => {
    setTopNText(text);
    const n = Number.parseInt(text, 10);
    const topN = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : null;
    setQuery((prev) => ({ ...prev, top_n: topN }));
  };

  const setOption = (patch: Partial<WidgetOptions>) => setOptions((prev) => ({ ...prev, ...patch }));

  // The form is `noValidate`: a target is stored only when the text reads as a
  // decimal number from 0 to `MAX_GAUGE_TARGET` ("85", "12,5"). Any other text —
  // and an emptied field — clears it, like Top N: the widget is saved without a
  // target rather than with the one the field no longer shows.
  const setTarget = (text: string) => {
    setTargetText(text);
    setOption({ target: parseTarget(text) });
  };

  // --- Dimension choices -------------------------------------------------------
  const allChoices = useMemo<DimensionChoice[]>(() => {
    const out: DimensionChoice[] = [];
    for (const { key, label } of DIMENSION_KINDS) {
      if (!isValidDimension(query.measure, key)) continue;
      // The common need (Person: views.staff) and the measure family's (capacity by person: absences).
      const needs = [dimensionNeeds(key), dimensionNeeds(key, query.measure)];
      if (needs.some((need) => need !== null && !heldKeys.has(need))) continue;
      if (isDimensionHidden(key, settings)) continue;
      if (key === 'field') {
        for (const field of fields) {
          if (field.field_type !== 'select' && field.field_type !== 'multiselect' && field.field_type !== 'toggle') {
            continue;
          }
          out.push({
            id: FIELD_ID_BASE + field.id,
            label: field.name,
            hint: 'Project field',
            dimension: { kind: 'field', field_id: field.id },
          });
        }
        continue;
      }
      const dimension: MetricDimension = key === 'period' ? { kind: 'period', grain: 'month' } : { kind: key };
      // Built-in fields under their instance labels (Customer, Confirmed); a period by its name.
      out.push({ id: kindId(key), label: key === 'period' ? label : dimensionLabel(dimension, fields, settings), dimension });
    }
    return out;
  }, [query.measure, heldKeys, settings, fields]);

  // Only the exact same choice is excluded: two different project fields cross. A
  // treemap or a sankey takes no period (its boxes or flows would be periods).
  const choicesFor = (index: 0 | 1): DimensionChoice[] => {
    const other = dimensions[index === 0 ? 1 : 0];
    return allChoices.filter(
      (c) =>
        (!other || dimensionKey(c.dimension) !== dimensionKey(other)) &&
        !(SUMMED_KINDS.has(kind) && c.dimension.kind === 'period')
    );
  };

  const pickDimension = (index: 0 | 1, id: number | null) => {
    if (id === null) {
      setDimension(index, null);
      return;
    }
    const choice = allChoices.find((c) => c.id === id);
    if (choice) setDimension(index, { ...choice.dimension });
  };

  const setGrain = (index: 0 | 1, grain: Grain) => {
    const next = [...dimensions];
    next[index] = { kind: 'period', grain };
    update(kind, { ...query, dimensions: next });
  };

  const dimensionField = (index: 0 | 1) => {
    const dimension = dimensions[index];
    const label = `Dimension ${index + 1}`;
    return (
      <div className={styles.dimensionRow}>
        <SearchableSelect
          label={label}
          className={styles.grow}
          fullWidth
          // A second dimension shown before the first is chosen (heatmap, sankey) waits for it.
          disabled={index === 1 && dimensions.length === 0}
          options={choicesFor(index)}
          value={dimension ? dimensionId(dimension) : null}
          onChange={(id) => pickDimension(index, id)}
          emptyLabel="None"
          placeholder="None"
          searchLabel={`Find a dimension for ${label}`}
          searchPlaceholder="Type to find a dimension…"
          noMatchText="No dimension matches"
          emptyText="No dimension for this measure"
        />
        {dimension?.kind === 'period' && (
          <Select
            label={`Grain of dimension ${index + 1}`}
            className={styles.grain}
            value={dimension.grain}
            onChange={(e) => setGrain(index, e.target.value as Grain)}
            options={GRAINS.map((g) => ({ value: g.key, label: g.label }))}
          />
        )}
      </div>
    );
  };

  // --- Filter choices ----------------------------------------------------------
  const allSites = useAppStore((s) => s.sites);
  const siteName = useMemo(() => new Map(allSites.map((s) => [s.id, s.name])), [allSites]);
  const filterOptions = useMemo<Record<ListFilter, MultiSelectDropdownItem[]>>(() => {
    const teamItems = teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? undefined,
      hint: siteName.get(t.site_id),
    }));
    const archived = filters.archived ?? 'exclude';
    const projectItems = projects
      .filter((p) => (archived === 'exclude' ? !p.archived : archived === 'only' ? p.archived : true))
      .map((p) => ({ id: p.id, name: p.name, hint: siteName.get(p.site_id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      site_ids: sites.map((s) => ({ id: s.id, name: s.name })),
      team_ids: teamItems,
      project_team_ids: teamItems,
      person_ids: uniqueById(staff)
        .map((s) => ({ id: s.id, name: s.name, hint: s.role || undefined }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      project_ids: projectItems,
      tag_ids: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      // The store holds one row per equipment-site pair (empty without views.equipment).
      equipment_ids: uniqueById(equipment)
        .map((e) => ({
          id: e.id,
          name: e.name,
          hint:
            (e.site_ids ?? [e.site_id])
              .map((id) => siteName.get(id))
              .filter(Boolean)
              .join(', ') || undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [teams, projects, staff, tags, equipment, sites, siteName, filters.archived]);

  // Equipment types are names: the picker numbers them (1-based, in name order),
  // a stored type no equipment has any more kept so it can be removed.
  const equipmentTypes = useMemo(() => {
    const names = new Set<string>();
    for (const e of equipment) if (e.type?.trim()) names.add(e.type);
    for (const name of filters.equipment_types ?? []) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [equipment, filters.equipment_types]);

  const listFilter = (key: ListFilter, searchable = false) => (
    <MultiSelectDropdown
      key={key}
      label={FILTER_LABELS[key]}
      options={filterOptions[key]}
      selectedIds={new Set(filters[key] ?? [])}
      onChange={(ids) => setFilters({ [key]: ids })}
      placeholder="Any"
      emptyText="Nothing to choose"
      searchable={searchable}
      searchLabel={`Find ${FILTER_LABELS[key].toLowerCase()}`}
    />
  );

  const dropdownFields = fields.filter((f) => f.field_type === 'select' || f.field_type === 'multiselect');

  // --- Measures ----------------------------------------------------------------------
  // Those whose key the user holds; the current one always (a stored widget of a lost key).
  const measureGroups = measuresByFamily((m) => m === query.measure || holds(measureNeeds(m)));

  // --- Period ----------------------------------------------------------------------
  const period = filters.period ?? { relative: 'this_year' as RelativePeriod };
  const periodMode = 'relative' in period ? period.relative : 'custom';
  const setPeriodMode = (value: string) => {
    if (value === 'custom') {
      setFilters({ period: 'from' in period ? period : { from: '', to: '' } });
    } else {
      setFilters({ period: { relative: value as RelativePeriod } });
    }
  };

  // --- Percent of / Top N ---------------------------------------------------------------
  const percentOptions = [{ value: '', label: 'None' }];
  if (dimensions.length > 0) percentOptions.push({ value: 'total', label: 'Total' });
  // Not on a treemap or a sankey (below): every parent would be drawn the same size.
  if (dimensions.length === 2) percentOptions.push({ value: 'first_dimension', label: 'First dimension' });
  const topNDisabled = dimensions.length === 0 || dimensions[0].kind === 'period';

  // --- KPI bucket (from the preview) ----------------------------------------------------
  const bucketOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of previewResult?.rows ?? []) {
      const key = row.keys[0];
      if (!key || key.key === null || key.key === OTHER_KEY) continue;
      const value = bucketValue(key.key);
      if (!seen.has(value)) seen.set(value, key.label);
    }
    const stored = options.kpi_bucket;
    if (stored !== undefined && stored !== null && !seen.has(bucketValue(stored))) {
      seen.set(bucketValue(stored), String(stored));
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [previewResult, options.kpi_bucket]);

  // --- Save --------------------------------------------------------------------------------
  const handleSave = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = title.trim();
    setTitleError(trimmed ? null : TITLE_REQUIRED);
    // A KPI share shows one value's share: it needs that value (the preview still runs without it).
    const noBucket =
      kind === 'kpi' && Boolean(query.percent_of) && (options.kpi_bucket === undefined || options.kpi_bucket === null);
    const formProblem = problem ?? (noBucket ? KPI_BUCKET_REQUIRED : null);
    setFormError(formProblem);
    if (!trimmed || formProblem || preview.status === 'invalid') return;
    if (!begin()) return;
    try {
      const saved: DraftWidget = {
        ...(widget?.id !== undefined ? { id: widget.id } : {}),
        clientId: widget?.clientId ?? newClientId(),
        kind,
        title: trimmed,
        query: clean,
        options: cleanOptions(kind, query, options),
        layout: widget?.layout ?? placeNewWidget(kind, widgets),
      };
      const matching = preview.status === 'ok' && preview.key === previewKey ? preview.result : null;
      onSave(saved, matching);
    } finally {
      end();
    }
  };

  const footer = (
    <div className={styles.footer}>
      <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        type="button"
        onClick={() => handleSave()}
        loading={isSubmitting}
        disabled={preview.status === 'invalid'}
        title={preview.status === 'invalid' ? 'The server refuses this widget: see the preview' : undefined}
      >
        {widget ? 'Save Changes' : 'Add widget'}
      </Button>
    </div>
  );

  const filterCount = activeFilterCount(filters);

  return (
    <Modal isOpen onClose={onClose} title={widget ? 'Edit widget' : 'Add widget'} size="xxl" footer={footer}>
      <form className={styles.form} onSubmit={handleSave} noValidate>
        <div className={styles.columns}>
          <div className={styles.fields}>
            {formError && <Notice tone="error">{formError}</Notice>}

            <KindPicker value={kind} onChange={changeKind} />

            <Input
              label="Title *"
              fullWidth
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => {
                setTitle(e.target.value);
                if (titleError) setTitleError(null);
              }}
              error={titleError ?? undefined}
            />

            <Select
              label="Measure"
              fullWidth
              value={query.measure}
              onChange={(e) => update(kind, dropUnheld(changeMeasure(kind, query, e.target.value as Measure), holds))}
              options={[]}
              groups={measureGroups}
              hint={measureHint(query.measure)}
            />

            {/* A gauge, and a KPI of a measure that takes no percentage, show the total: no dimension.
                A heatmap and a sankey show both fields at once (they need two). */}
            {!noDimension && dimensionField(0)}
            {!noDimension &&
              MAX_DIMENSIONS[kind] > 1 &&
              (dimensions.length > 0 || MIN_DIMENSIONS[kind] > 1) &&
              dimensionField(1)}

            <section className={styles.section}>
              <Button
                type="button"
                variant="ghost"
                className={styles.disclosure}
                aria-expanded={filtersOpen}
                aria-controls={filtersId}
                icon={<Icon icon={filtersOpen ? ChevronDownIcon : ChevronRightIcon} />}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
              </Button>
              {filtersOpen && (
                <div id={filtersId} className={styles.filters}>
                  {showsFilter('site_ids') && listFilter('site_ids')}
                  {showsFilter('team_ids') && listFilter('team_ids', true)}
                  {showsFilter('project_team_ids') && listFilter('project_team_ids', true)}
                  {showsFilter('person_ids') && listFilter('person_ids', true)}
                  {showsFilter('project_ids') && listFilter('project_ids', true)}
                  {showsFilter('tag_ids') && listFilter('tag_ids')}
                  {showsFilter('equipment_ids') && listFilter('equipment_ids', true)}
                  {showsFilter('equipment_types') && (
                    <MultiSelectDropdown
                      label={FILTER_LABELS.equipment_types}
                      options={equipmentTypes.map((name, i) => ({ id: i + 1, name }))}
                      selectedIds={
                        new Set((filters.equipment_types ?? []).map((name) => equipmentTypes.indexOf(name) + 1))
                      }
                      onChange={(ids) => setFilters({ equipment_types: ids.map((id) => equipmentTypes[id - 1]) })}
                      placeholder="Any"
                      emptyText="No equipment type"
                    />
                  )}
                  {showsFilter('field_options') && dropdownFields.map((field) => (
                    <MultiSelectDropdown
                      key={`field-${field.id}`}
                      label={field.name}
                      options={field.options.map((o) => ({ id: o.id, name: o.name, color: o.color ?? undefined }))}
                      selectedIds={new Set(filters.field_options?.[String(field.id)] ?? [])}
                      onChange={(ids) =>
                        setFilters({ field_options: { ...(filters.field_options ?? {}), [String(field.id)]: ids } })
                      }
                      placeholder="Any"
                      emptyText="No item"
                    />
                  ))}
                  {showsFilter('milestones') && (
                    <Select
                      label={FILTER_LABELS.milestones}
                      fullWidth
                      value={filters.milestones ?? 'include'}
                      onChange={(e) => setFilters({ milestones: e.target.value as MetricFilters['milestones'] })}
                      options={MILESTONE_OPTIONS}
                    />
                  )}
                  {showsFilter('confirmed') && (
                    <Select
                      label={FILTER_LABELS.confirmed}
                      fullWidth
                      value={typeof filters.confirmed === 'boolean' ? String(filters.confirmed) : 'any'}
                      onChange={(e) =>
                        setFilters({ confirmed: e.target.value === 'any' ? null : e.target.value === 'true' })
                      }
                      options={[
                        { value: 'any', label: 'Any' },
                        { value: 'true', label: 'Confirmed' },
                        { value: 'false', label: 'Not confirmed' },
                      ]}
                    />
                  )}
                  {showsFilter('archived') && (
                    <Select
                      label="Archived projects"
                      fullWidth
                      value={filters.archived ?? 'exclude'}
                      onChange={(e) => setFilters({ archived: e.target.value as MetricFilters['archived'] })}
                      options={[
                        { value: 'exclude', label: 'Exclude' },
                        ...(canArchived || filters.archived === 'include'
                          ? [{ value: 'include', label: 'Include' }]
                          : []),
                        ...(canArchived || filters.archived === 'only' ? [{ value: 'only', label: 'Only' }] : []),
                      ]}
                    />
                  )}
                </div>
              )}
            </section>

            <Select
              label="Period"
              fullWidth
              value={periodMode}
              onChange={(e) => setPeriodMode(e.target.value)}
              options={[
                ...RELATIVE_PERIODS.map((p) => ({ value: p.key, label: p.label })),
                { value: 'custom', label: 'Custom…' },
              ]}
            />
            {'from' in period && (
              <div className={styles.row}>
                <DateRangeField
                  start={period.from}
                  end={period.to}
                  onChange={({ start, end: to }) => setFilters({ period: { from: start, to } })}
                  startLabel="From"
                  endLabel="To"
                  fieldClassName={styles.cell}
                  markSiteCalendar={false}
                />
              </div>
            )}

            {/* Without a dimension there is nothing to take a percentage of, nor to rank. */}
            {!noDimension && (
              <div className={styles.row}>
                {/* Utilisation, available days and people over capacity take no percentage. */}
                {!noPercent && (
                  <Select
                    label="Percent of"
                    fullWidth
                    value={query.percent_of ?? ''}
                    onChange={(e) => setPercentOf(e.target.value)}
                    options={kind === 'kpi' || SUMMED_KINDS.has(kind) ? percentOptions.slice(0, 2) : percentOptions}
                    disabled={dimensions.length === 0}
                  />
                )}
                <Input
                  label="Top N"
                  type="number"
                  fullWidth
                  min={1}
                  max={50}
                  step={1}
                  value={topNDisabled ? '' : topNText}
                  onChange={(e) => setTopN(e.target.value)}
                  disabled={topNDisabled}
                  hint={topNDisabled ? undefined : 'The largest values; the rest as Other'}
                />
              </div>
            )}

            <KindOptions
              kind={kind}
              options={options}
              stackable={!noPercent}
              share={Boolean(query.percent_of)}
              percentUnit={queryUnit(query) === 'percent'}
              unitHint={queryUnit(query) === 'percent' ? 'In %' : `In ${unitWord(2, queryUnit(query))}`}
              bucketOptions={bucketOptions}
              targetText={targetText}
              onTargetChange={setTarget}
              onChange={setOption}
            />
          </div>

          <aside className={styles.preview} aria-label="Preview">
            <p className={styles.previewLabel}>Preview</p>
            <div className={styles.previewBody}>{renderPreview()}</div>
          </aside>
        </div>
      </form>
    </Modal>
  );

  function renderPreview(): ReactNode {
    if (problem) return <p className={styles.previewNote}>{problem}</p>;
    if (preview.status === 'invalid') return <Notice tone="error">{preview.message}</Notice>;
    if (preview.status === 'unavailable') {
      return (
        <p className={styles.previewNote} role="status">
          {PREVIEW_UNAVAILABLE}
        </p>
      );
    }
    return (
      <WidgetCard
        widget={{
          id: 0,
          kind,
          title: title.trim() || 'Untitled widget',
          query: clean,
          options: cleanOptions(kind, query, options),
          layout: placeNewWidget(kind, []),
          sort_order: 0,
        }}
        result={previewResult ?? undefined}
        loading={preview.status === 'loading'}
      />
    );
  }
}

interface KindPickerProps {
  value: WidgetKind;
  onChange: (kind: WidgetKind) => void;
}

/** The nine kinds as a radio group: arrows move and choose, one tab stop. */
function KindPicker({ value, onChange }: KindPickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = WIDGET_KINDS.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    onChange(WIDGET_KINDS[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.kindGroup}>
      <span className={styles.label} id={labelId}>
        Kind
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className={styles.kinds}>
        {WIDGET_KINDS.map((k, index) => {
          const checked = k.key === value;
          return (
            <button
              key={k.key}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className={`${styles.kind}${checked ? ` ${styles.kindChecked}` : ''}`}
              onClick={() => onChange(k.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              <Icon icon={k.icon} size={16} />
              <span>{k.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface KindOptionsProps {
  kind: WidgetKind;
  options: WidgetOptions;
  /** A bar may be stacked or 100 % (not for a measure that takes no percentage) */
  stackable: boolean;
  /** The query asks a percentage (a KPI then shows one bucket) */
  share: boolean;
  /** The result comes in percent: only then is the *Percent* number format offered */
  percentUnit: boolean;
  /** The unit of the result, under the gauge's target ("In weeks", "In %") */
  unitHint: string;
  bucketOptions: { value: string; label: string }[];
  /** The gauge target as typed (kept apart from the stored number) */
  targetText: string;
  onTargetChange: (text: string) => void;
  onChange: (patch: Partial<WidgetOptions>) => void;
}

/** The display options of a kind (a gauge: its target), and the number format of every kind. */
function KindOptions({
  kind,
  options,
  stackable,
  share,
  percentUnit,
  unitHint,
  bucketOptions,
  targetText,
  onTargetChange,
  onChange,
}: KindOptionsProps) {
  const numberFormat = options.number_format === 'percent' && !percentUnit ? '' : options.number_format ?? '';
  return (
    <div className={styles.options}>
      {kind === 'bar' && (
        <>
          {/* Utilisation, available days, people over capacity: no stack of them adds up. */}
          {stackable && (
            <ToggleSwitch
              label="Stacked"
              checked={Boolean(options.stacked || options.percent)}
              disabled={Boolean(options.percent)}
              onChange={(stacked) => onChange({ stacked })}
            />
          )}
          {stackable && (
            <ToggleSwitch
              label="100 %"
              checked={Boolean(options.percent)}
              onChange={(percent) => onChange(percent ? { percent, stacked: true } : { percent })}
            />
          )}
          <Select
            label="Orientation"
            fullWidth
            value={options.orientation ?? 'vertical'}
            onChange={(e) => onChange({ orientation: e.target.value as WidgetOptions['orientation'] })}
            options={[
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
            ]}
          />
        </>
      )}
      {kind === 'line' && (
        <ToggleSwitch
          label="Show legend"
          checked={options.show_legend !== false}
          onChange={(show) => onChange({ show_legend: show })}
        />
      )}
      {kind === 'pie' && (
        <ToggleSwitch
          label="Show legend"
          checked={options.show_legend === true}
          onChange={(show) => onChange({ show_legend: show })}
        />
      )}
      {kind === 'gauge' && (
        <Input
          label="Target"
          type="text"
          inputMode="decimal"
          fullWidth
          placeholder="No target"
          value={targetText}
          onChange={(e) => onTargetChange(e.target.value)}
          hint={unitHint}
        />
      )}
      {kind === 'kpi' && share && (
        <Select
          label="Bucket"
          fullWidth
          value={options.kpi_bucket === undefined || options.kpi_bucket === null ? '' : bucketValue(options.kpi_bucket)}
          onChange={(e) => onChange({ kpi_bucket: e.target.value ? (JSON.parse(e.target.value) as WidgetOptions['kpi_bucket']) : null })}
          options={bucketOptions}
          placeholder={bucketOptions.length > 0 ? 'Choose a value' : 'Waiting for the preview'}
          hint="The value whose share the KPI shows"
        />
      )}
      <Select
        label="Number format"
        fullWidth
        value={numberFormat}
        onChange={(e) =>
          onChange({ number_format: (e.target.value || null) as WidgetOptions['number_format'] })
        }
        options={[
          { value: '', label: 'Auto' },
          { value: 'integer', label: 'Integer' },
          { value: 'decimal', label: 'Decimal' },
          ...(percentUnit ? [{ value: 'percent', label: 'Percent' }] : []),
        ]}
      />
    </div>
  );
}
