/**
 * The names of the filter values (sites, teams, people, projects, tags,
 * equipment, project fields) from the store, for the formula field's pills
 * (`termSummary.pillLabel`).
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { uniqueById } from '@/utils/uniqueById';
import type { NameLookups } from './termSummary';

export function useNameLookups(): NameLookups {
  const teams = useAppStore((s) => s.teams);
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const tags = useAppStore((s) => s.tags);
  const equipment = useAppStore((s) => s.equipment);
  const sites = useAppStore((s) => s.sites);
  const fields = useAppStore((s) => s.projectFields);
  return useMemo<NameLookups>(
    () => ({
      sites: new Map(sites.map((s) => [s.id, s.name])),
      teams: new Map(teams.map((t) => [t.id, t.name])),
      people: new Map(uniqueById(staff).map((s) => [s.id, s.name])),
      projects: new Map(projects.map((p) => [p.id, p.name])),
      tags: new Map(tags.map((t) => [t.id, t.name])),
      equipment: new Map(uniqueById(equipment).map((e) => [e.id, e.name])),
      fields,
    }),
    [sites, teams, staff, projects, tags, equipment, fields]
  );
}
