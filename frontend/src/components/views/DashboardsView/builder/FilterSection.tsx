/**
 * FilterSection — the filters of one measure in the widget editor (2.6.0), a
 * collapsible section closed while none is set.
 *
 * Shared by the measure of a widget and the divisor of a calculated widget
 * (*Divide by*), each with its own filters: it shows only the filters the
 * measure takes (`takesFilter`) and the user may use (`holds`: People needs
 * `views.staff`, and on a capacity measure `absences.view_others`; Equipment
 * and Equipment types `views.equipment`). The period is not here: a
 * calculated widget's two sides share the widget's period.
 */

import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/common/Button';
import { Select } from '@/components/common/Select';
import { MultiSelectDropdown } from '@/components/common/MultiSelectDropdown';
import type { MultiSelectDropdownItem } from '@/components/common/MultiSelectDropdown';
import { Icon, ChevronDownIcon, ChevronRightIcon } from '@/components/common/Icon';
import { useAppStore } from '@/stores/appStore';
import { useVisibleSites } from '@/hooks/useVisibleSites';
import { uniqueById } from '@/utils/uniqueById';
import { isBuiltInFieldHidden } from '@/utils/instanceSettings';
import { FILTER_LABELS, filterNeeds, takesFilter } from '@/utils/metrics';
import type { FilterKey } from '@/utils/metrics';
import type { Measure, MetricFilters } from '@/types';
import type { PermissionKey } from '@/types/permissions';
import { activeFilterCount } from './widgetDraft';
import styles from './WidgetEditor.module.css';

const MILESTONE_OPTIONS = [
  { value: 'include', label: 'Include' },
  { value: 'only', label: 'Only' },
  { value: 'exclude', label: 'Exclude' },
];

const HAS_CUSTOMER_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'true', label: 'With a customer' },
  { value: 'false', label: 'Without a customer' },
];

/** The hint of Utilisation's filters: project filters narrow its booked side only. */
export const UTILISATION_FILTERS_HINT =
  'Project filters narrow the booked time only; the capacity stays that of the people in scope.';

type ListFilter = 'site_ids' | 'team_ids' | 'project_team_ids' | 'person_ids' | 'project_ids' | 'tag_ids' | 'equipment_ids';

export interface FilterSectionProps {
  measure: Measure;
  filters: Omit<MetricFilters, 'period'>;
  onChange: (patch: Partial<MetricFilters>) => void;
  /** Whether the user holds a key (null: nothing needed) */
  holds: (key: PermissionKey | null) => boolean;
  /** The disclosure's name ("Filters", "Divisor filters") */
  title?: string;
}

/** The filters a measure takes, each a shared field, under a disclosure. */
export function FilterSection({ measure, filters, onChange, holds, title = 'Filters' }: FilterSectionProps) {
  const [open, setOpen] = useState(() => activeFilterCount(filters) > 0);
  const panelId = useId();
  const canArchived = holds('views.archived');
  const fields = useAppStore((s) => s.projectFields);
  const settings = useAppStore((s) => s.instanceSettings);
  const teams = useAppStore((s) => s.teams);
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const tags = useAppStore((s) => s.tags);
  const equipment = useAppStore((s) => s.equipment);
  const allSites = useAppStore((s) => s.sites);
  const sites = useVisibleSites();

  const shows = (key: FilterKey): boolean =>
    takesFilter(measure, key) && holds(filterNeeds(key)) && holds(filterNeeds(key, measure));

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
      onChange={(ids) => onChange({ [key]: ids })}
      placeholder="Any"
      emptyText="Nothing to choose"
      searchable={searchable}
      searchLabel={`Find ${FILTER_LABELS[key].toLowerCase()}`}
    />
  );

  const dropdownFields = fields.filter((f) => f.field_type === 'select' || f.field_type === 'multiselect');
  // Has a customer follows the Customer field: hidden instance-wide, it is offered only to clear a stored value.
  const customerHidden = isBuiltInFieldHidden(settings, 'customer') && typeof filters.has_customer !== 'boolean';
  const count = activeFilterCount(filters);

  return (
    <section className={styles.section}>
      <Button
        type="button"
        variant="ghost"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={panelId}
        icon={<Icon icon={open ? ChevronDownIcon : ChevronRightIcon} />}
        onClick={() => setOpen((value) => !value)}
      >
        {count > 0 ? `${title} (${count})` : title}
      </Button>
      {open && (
        <div id={panelId} className={styles.filters} role="group" aria-label={title}>
          {measure === 'utilisation' && <p className={styles.hint}>{UTILISATION_FILTERS_HINT}</p>}
          {shows('site_ids') && listFilter('site_ids')}
          {shows('team_ids') && listFilter('team_ids', true)}
          {shows('project_team_ids') && listFilter('project_team_ids', true)}
          {shows('person_ids') && listFilter('person_ids', true)}
          {shows('project_ids') && listFilter('project_ids', true)}
          {shows('tag_ids') && listFilter('tag_ids')}
          {shows('equipment_ids') && listFilter('equipment_ids', true)}
          {shows('equipment_types') && (
            <MultiSelectDropdown
              label={FILTER_LABELS.equipment_types}
              options={equipmentTypes.map((name, i) => ({ id: i + 1, name }))}
              selectedIds={new Set((filters.equipment_types ?? []).map((name) => equipmentTypes.indexOf(name) + 1))}
              onChange={(ids) => onChange({ equipment_types: ids.map((id) => equipmentTypes[id - 1]) })}
              placeholder="Any"
              emptyText="No equipment type"
            />
          )}
          {shows('field_options') &&
            dropdownFields.map((field) => (
              <MultiSelectDropdown
                key={`field-${field.id}`}
                label={field.name}
                options={field.options.map((o) => ({ id: o.id, name: o.name, color: o.color ?? undefined }))}
                selectedIds={new Set(filters.field_options?.[String(field.id)] ?? [])}
                onChange={(ids) => onChange({ field_options: { ...(filters.field_options ?? {}), [String(field.id)]: ids } })}
                placeholder="Any"
                emptyText="No item"
              />
            ))}
          {shows('milestones') && (
            <Select
              label={FILTER_LABELS.milestones}
              fullWidth
              value={filters.milestones ?? 'include'}
              onChange={(e) => onChange({ milestones: e.target.value as MetricFilters['milestones'] })}
              options={MILESTONE_OPTIONS}
            />
          )}
          {shows('confirmed') && (
            <Select
              label={FILTER_LABELS.confirmed}
              fullWidth
              value={typeof filters.confirmed === 'boolean' ? String(filters.confirmed) : 'any'}
              onChange={(e) => onChange({ confirmed: e.target.value === 'any' ? null : e.target.value === 'true' })}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'true', label: 'Confirmed' },
                { value: 'false', label: 'Not confirmed' },
              ]}
            />
          )}
          {shows('has_customer') && !customerHidden && (
            <Select
              label={FILTER_LABELS.has_customer}
              fullWidth
              value={typeof filters.has_customer === 'boolean' ? String(filters.has_customer) : 'any'}
              onChange={(e) =>
                onChange({ has_customer: e.target.value === 'any' ? null : e.target.value === 'true' })
              }
              options={HAS_CUSTOMER_OPTIONS}
            />
          )}
          {shows('archived') && (
            <Select
              label="Archived projects"
              fullWidth
              value={filters.archived ?? 'exclude'}
              onChange={(e) => onChange({ archived: e.target.value as MetricFilters['archived'] })}
              options={[
                { value: 'exclude', label: 'Exclude' },
                ...(canArchived || filters.archived === 'include' ? [{ value: 'include', label: 'Include' }] : []),
                ...(canArchived || filters.archived === 'only' ? [{ value: 'only', label: 'Only' }] : []),
              ]}
            />
          )}
        </div>
      )}
    </section>
  );
}
