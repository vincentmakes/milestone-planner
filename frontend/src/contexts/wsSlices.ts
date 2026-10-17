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
  | 'absenceTypes'
  /** Bank holidays + company events of the site currently being viewed */
  | 'siteCalendar'
  /** Custom-column definitions + values of the site currently being viewed (customColumnStore) */
  | 'customColumns'
  /** Instance settings (title, show_weekends, …) — appStore.instanceSettings */
  | 'settings'
  /**
   * The signed-in user's own record (role, sites, name) — appStore.currentUser.
   * An admin editing or disabling this user takes effect without a reload.
   */
  | 'currentUser';

export const ALL_SLICES: Slice[] = [
  'projects', 'staff', 'equipment', 'equipmentBlocks', 'vacations',
  'sites', 'skills', 'tags', 'absenceTypes', 'siteCalendar', 'customColumns',
  'settings', 'currentUser',
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
      return ['settings'];
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
      // the one signed in here (role/site changes, deactivation).
      return ['staff', 'currentUser', 'projects'];
    case 'equipment':
      return ['equipment', 'projects'];
    case 'equipment_block':
      return ['equipmentBlocks'];
    case 'vacation':
      return ['vacations'];
    case 'site':
      // Site writes include holiday refreshes and site-scoped event links, so
      // the current site's calendar (holidays/events) is refetched as well.
      // Deleting a site cascades its projects on the server (FK CASCADE), so
      // the project list is reloaded too.
      return ['sites', 'siteCalendar', 'projects'];
    case 'skill':
      return ['skills', 'staff'];
    case 'tag':
      return ['tags', 'projects'];
    case 'tag_group':
      // Groups live in the same slice as tags (both reloaded together); the
      // project tree does not change when a group is edited.
      return ['tags'];
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
