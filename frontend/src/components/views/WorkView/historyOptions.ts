/**
 * The options of the History tab's pickers.
 *
 * People: the active users (`appStore.users`, loaded only by Settings →
 * Users), the active staff (every bookable person at the loaded sites) and
 * the requesters and deciders of the rows held — deciders are often
 * managers who are not bookable, and `decided` rows may come from any site.
 * Projects: the loaded projects and the projects of the rows held.
 *
 * `seen` remembers every id → name met so far (the caller keeps it across
 * renders), so a chosen person or project keeps its option once the filtered
 * list stops showing them. Sorted by name.
 */

import type { SearchableOption } from '@/components/common/SearchableSelect';
import type { ApprovalRequest, Project, Staff, User } from '@/types';

function sorted(seen: Map<number, string>): SearchableOption[] {
  return Array.from(seen, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function userName(user: User): string {
  return user.name || `${user.first_name} ${user.last_name}`.trim();
}

export function historyPeople(
  seen: Map<number, string>,
  users: readonly User[],
  staff: readonly Staff[],
  rows: readonly ApprovalRequest[]
): SearchableOption[] {
  for (const user of users) {
    if (user.active) seen.set(user.id, userName(user));
  }
  for (const person of staff) {
    if (person.active && !seen.has(person.id)) seen.set(person.id, person.name);
  }
  for (const row of rows) {
    if (row.requester_name && !seen.has(row.requester_id)) seen.set(row.requester_id, row.requester_name);
    if (row.decided_by !== null && row.decided_by_name && !seen.has(row.decided_by)) {
      seen.set(row.decided_by, row.decided_by_name);
    }
  }
  return sorted(seen);
}

export function historyProjects(
  seen: Map<number, string>,
  projects: readonly Project[],
  rows: readonly ApprovalRequest[]
): SearchableOption[] {
  for (const project of projects) seen.set(project.id, project.name);
  for (const row of rows) {
    if (row.project_name && !seen.has(row.project_id)) seen.set(row.project_id, row.project_name);
  }
  return sorted(seen);
}
