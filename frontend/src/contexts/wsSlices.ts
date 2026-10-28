/**
 * WebSocket refetch slices.
 *
 * A `change:<entity>` event from the server is mapped to the data slices the
 * client must reload (see WebSocketContext's coalescing refresh runner).
 * Kept in a plain module so the mapping is unit-testable.
 */

export type Slice =
  | 'projects'
  | 'staff'
  | 'equipment'
  | 'equipmentBlocks'
  | 'vacations'
  | 'sites'
  | 'skills'
  | 'tags'
  /** Project field definitions with their items — appStore.projectFields */
  | 'projectFields'
  /** Teams of every site — appStore.teams */
  | 'teams'
  /** Roles with their matrices and user counts — appStore.roles */
  | 'roles'
  | 'absenceTypes'
  /** Bank holidays + company events of the site currently being viewed */
  | 'siteCalendar'
  /** Custom-column definitions + values of the site currently being viewed (customColumnStore) */
  | 'customColumns'
  /** Instance settings (title, show_weekends, …) — appStore.instanceSettings */
  | 'settings'
  /**
   * The signed-in user's own record (role, sites, name) — appStore.currentUser.
   * An admin editing or disabling this user takes effect without a reload,
   * and so does a role edit (permissions, approval modes, visible sites).
   */
  | 'currentUser'
  /** Approval requests (own and to decide) — the My Work view (workStore) */
  | 'approvals'
  /** Who approves each own-booking action — appStore.approvalPolicies (pending badges) */
  | 'approvalPolicies';

export const ALL_SLICES: Slice[] = [
  'projects', 'staff', 'equipment', 'equipmentBlocks', 'vacations',
  'sites', 'skills', 'tags', 'projectFields', 'teams', 'roles', 'absenceTypes', 'siteCalendar', 'customColumns',
  'settings', 'currentUser', 'approvals', 'approvalPolicies',
];

/**
 * Slices that hold What-If sandbox state. While What-If mode is active the
 * local copy IS the plan being edited (its writes are queued, not sent), so a
 * teammate's change must not replace it on screen. Refreshes of these slices
 * are deferred and run once What-If mode exits (Discard restores a snapshot
 * that may predate the teammate's change; Apply reloads anyway).
 */
export const WHAT_IF_SANDBOXED_SLICES: ReadonlySet<Slice> = new Set<Slice>(['projects', 'customColumns']);

/** Map an entity_type from the server to the data slices that need to be reloaded. */
export function slicesForEntity(entityType: string): Slice[] {
  switch (entityType) {
    // Project tree (and assignments live inside projects)
    case 'project':
    case 'phase':
    case 'subphase':
    case 'assignment':            // legacy generic, kept for back-compat
    case 'staff_assignment':
    case 'equipment_assignment':
    case 'predefined_phase':
      return ['projects'];
    case 'note':
      // Staff notes have no view in this SPA (nothing in the stores holds
      // them), so there is nothing to reload. Before this case every note
      // write fell through to ALL_SLICES / the N+1 project reload.
      return [];
    case 'settings':
      // The Kanban switch takes views.kanban away from everyone, so the
      // signed-in user's resolved permissions (/auth/me) move with it.
      return ['settings', 'currentUser'];
    case 'custom_column':
    case 'custom_column_value':
      // Definitions and values live in customColumnStore, not the project tree.
      // The backend emits `custom_column` for every /api/custom-columns write,
      // value writes included.
      return ['customColumns'];
    case 'bank_holiday':
    case 'company_event':
      // Holidays and events live in the current site's calendar, not in the
      // project tree; the timelines read them from the store's date sets.
      return ['siteCalendar'];
    case 'absence_type':
      // Vacations too: their absence_type_id can change server-side when a type
      // is removed (ON DELETE SET NULL).
      return ['absenceTypes', 'vacations'];
    case 'staff':
      return ['staff', 'projects'];
    case 'user':
      // Staff are users; assignments carry their names. The user may also be
      // the one signed in here (role/site changes, deactivation). A deleted
      // user also leaves their teams' member_ids, and a role change moves the
      // roles' user counts (Settings → Roles).
      return ['staff', 'currentUser', 'projects', 'teams', 'roles'];
    case 'equipment':
      return ['equipment', 'projects'];
    case 'equipment_block':
      return ['equipmentBlocks'];
    case 'vacation':
      return ['vacations'];
    case 'site':
      // Site writes include holiday refreshes and site-scoped event links, so
      // the current site's calendar (holidays/events) is refetched as well.
      // Site writes are rare admin actions, and a delete cascades on the
      // server to the site's projects (FK CASCADE), site-only tags, site-only
      // project field items and site-only equipment, which other clients
      // would otherwise keep showing — so those slices reload too, and so do
      // the site's teams. The signed-in user's own record (their sites) and
      // the staff rows (their site lists) move with a delete too: a user whose
      // only site vanished is re-evaluated instead of staying on it.
      return [
        'sites', 'siteCalendar', 'projects', 'tags', 'projectFields', 'equipment', 'teams',
        'currentUser', 'staff',
      ];
    case 'skill':
      return ['skills', 'staff'];
    case 'tag':
      return ['tags', 'projects'];
    case 'project_field':
      // Every /api/project-fields write (fields and items). Deleting a field
      // or an item removes project values server-side, so the tree reloads.
      return ['projectFields', 'projects'];
    case 'team':
      // Membership changes staff rows' team_ids. A team delete cascades on
      // the server to its project, tag, field item, equipment and
      // company-event links; like 'site', a rare admin action, so those
      // slices reload too.
      return ['teams', 'staff', 'projects', 'tags', 'projectFields', 'equipment', 'siteCalendar'];
    case 'role':
      // The signed-in user's resolved permissions (/auth/me) and the role
      // list (Settings → Roles, the role pickers).
      return ['currentUser', 'roles'];
    case 'approval_policy':
      // Who may approve changes the approver names on pending badges and the
      // requests the user may decide. approval_required (/auth/me) comes from
      // the role's modes, so a role edit (change:role) refreshes that.
      return ['approvalPolicies', 'approvals'];
    case 'approval_request':
      // Approve/reject/cancel flip or remove pending assignment rows.
      return ['projects', 'approvals'];
    case 'card_comment':
      // Comment threads and counts have their own fetches. Without this case
      // every comment anyone posts would refetch every slice -- including
      // the per-project project load -- on every connected client.
      return [];
    default:
      // Unknown type: refresh everything to be safe.
      return ALL_SLICES;
  }
}
