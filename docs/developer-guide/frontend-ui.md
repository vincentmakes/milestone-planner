# UI guidelines

These are the frontend conventions that keep the interface consistent. They apply to every new
screen, panel and dialog. The components named here live in `frontend/src/components/common/`
unless stated otherwise.

## Buttons

Every action button is the shared `Button` component (`components/common/Button`). Don't write a
raw `<button>` with local styles for an action. Raw buttons are fine for controls that are not
actions: option chips, tabs, colour swatches, list rows you can click, and the compact row icons
described below.

```tsx
import { Button } from '@/components/common/Button';
import { PlusIcon } from '@/components/settings/panels/PanelIcons';

<Button icon={<PlusIcon />} onClick={handleCreate}>
  Add holiday
</Button>
```

### Variants

| Variant | Looks like | Use it for |
|---------|-----------|------------|
| `primary` (default) | Solid blue | The main action of a panel or dialog: **Add X**, **Create X**, **Save Changes**. At most one per toolbar or footer. |
| `secondary` | Bordered, neutral | Every other action next to the primary one: **Manage Skills**, **Import .ics**, **Export .ics**, **Refresh**, **Cancel**. |
| `ghost` | Text only, background on hover | Back links (**Back to list**, **All sites**), low-emphasis actions inside rows, and the admin-portal **Logout**. |
| `danger` | Solid red | Destructive confirmations (**Delete User**). |
| `icon` | Square, transparent | An icon-only button. Always give it an `aria-label` (and usually a `title`). |

### Sizes

| Size | Height | Use it for |
|------|--------|------------|
| `md` (default) | 36 px | Everything: toolbars, add rows, back links, dialog footers. The add-row inputs in Settings are 36 px too, so they line up. |
| `sm` | 28 px | Only for actions repeated on every row of a dense list, such as **Edit** / **Delete** in *My absences*. |
| `lg` | 44 px | Large standalone calls to action, such as login screens. |

Don't use `sm` in a toolbar. A small primary button next to medium ones was the drift this guide
was written to stop.

### Icons

Pass icons through the `icon` prop. Don't put an inline `<svg>` with a hand-tuned `marginRight` in
the children. The button sizes the svg (14 px in `md`, 12 px in `sm`) and the gap, and the icon
inherits the text colour through `currentColor`. `iconPosition="right"` puts it after the label.

Take icons from `components/settings/panels/PanelIcons.tsx`: `PlusIcon`, `EditIcon`,
`TrashIcon`, `UnlinkIcon`, `DownloadIcon`, `UploadIcon`, `RefreshIcon`, `BackIcon`, `GearIcon`,
`LogoutIcon` and `DragHandleIcon`. Add a new icon there rather than inlining one. Every icon is
`aria-hidden`, so the button's accessible name is its label alone, and tests can keep selecting
buttons by role and exact name.

| Action | Icon |
|--------|------|
| Add / create | `PlusIcon` |
| Open a related management section (**Manage Skills**, **Manage Types**) | `GearIcon` |
| Import a file | `UploadIcon` |
| Export / download | `DownloadIcon` |
| Refresh from a source | `RefreshIcon` |
| Back | `BackIcon` |

### States

- `disabled` dims the button to 50 % opacity. That matches the global `button:disabled` rule in
  `styles/global.css`, so every disabled button looks the same.
- `loading` shows a spinner over the label and disables the button.
- Inside a `<form>`, set `type="button"` on every button that must not submit (back links,
  Cancel). Set `type="submit"` on the one that submits, as the Tags and Absence types add rows do.
  Pressing Enter in the input then submits the form.
- Writes from a dialog are guarded with `useSubmitGuard`, so a double click cannot create
  duplicates.

## Panel toolbar

Every Settings panel that has a toolbar uses `PanelToolbar` (`components/settings/PanelToolbar`).
Filters, counts or a search field go on the left. The panel's actions go on the right, secondary
ones first and the primary **Add X** last. A divider sits under the toolbar.

```tsx
import { Button } from '@/components/common/Button';
import { PanelToolbar } from '../PanelToolbar';
import { GearIcon, PlusIcon } from './PanelIcons';

<PanelToolbar
  left={<span className={styles.count}>{users.length} users</span>}
  right={
    canManage && (
      <>
        <Button variant="secondary" icon={<GearIcon />} onClick={openSkills}>
          Manage Skills
        </Button>
        <Button icon={<PlusIcon />} onClick={handleCreate}>
          Add User
        </Button>
      </>
    )
  }
/>
```

- Either slot may be left out. A `false` or `null` slot (a role-gated action) renders nothing, and
  the actions stay on the right.
- `align="end"` bottom-aligns both slots. Use it when the left slot holds labelled fields (a label
  stacked above a select, as in Bank holidays, Company events and Equipment), so the buttons line
  up with the controls and not with the middle of the label and control.
- The layout is a flex row with `space-between`, a 1 rem gap, wrapping, 0.75 rem padding below a
  1 px `--border-color` divider and a 0.75 rem margin after it. The actions are 0.5 rem apart.
  Don't redefine any of this in a panel's CSS module.

Panels without a toolbar keep their add control next to the input it belongs to, as Sites,
Predefined phases, Tags and Absence types do. That control is still a `md` primary `Button` with
`PlusIcon`.

## Back links

A view that replaces a list, such as an edit form or an import view, has a back link at its top.
Use a ghost `md` `Button` with `BackIcon`, labelled with where it goes: **Back to list**,
**Back to holidays**, **All sites**. Don't use a text arrow (`←`) or a styled link.

```tsx
<Button type="button" variant="ghost" icon={<BackIcon />} onClick={onCancel}>
  Back to list
</Button>
```

## Row actions

Edit, delete and similar actions repeated on every row of a table or list are compact 28 px
icon-only buttons (the panels' `.editBtn`, `.actionBtn` and `.iconBtn` rules), with `PanelIcons`
at their default size. Each one needs an `aria-label` that names the row, such as
`Delete ISO Audit`, and usually a `title`. They stay compact so a long list remains scannable.

## Toggles

Every on/off setting is a `ToggleSwitch` (`components/common/ToggleSwitch`). It is a visually
hidden checkbox with `role="switch"`, so keyboard, screen-reader and label behaviour come for
free. Pass `label` for visible text, or `aria-label` when there is none. Don't build a custom
switch, and don't use a bare checkbox for a setting.

## Tag pills

Tags are shown as rounded pills filled with the tag colour. The text colour always comes from
`barTextColor(tag.color)` (`utils/tags.ts`). It picks white or near-black, whichever contrasts
more, so a pill stays readable on light colours. Don't hard-code `color: white` on a coloured
background.

```tsx
<span
  className={styles.pill}
  style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}
>
  {tag.name}
</span>
```

## Dropdowns, popovers and context menus

Non-modal overlays such as dropdowns, filter panels, popovers and context menus close:

- on a `mousedown` outside the trigger and panel,
- when focus leaves the wrapper (Tab out), and
- on Escape. Listen in the capture phase and stop propagation, so the key closes only this panel
  and never reaches the app-wide keyboard shortcuts.

`TagFilterDropdown` is the reference implementation. A panel with checkboxes or radios is a
non-modal `role="dialog"` (not a `menu`) with an `aria-label`. Its trigger carries
`aria-expanded` and `aria-haspopup="dialog"`.

## Modals

Modals and dialogs close **only** through an explicit button or the Escape key. They never close
on a backdrop or outside click, because that would discard in-progress input (for example when a
text-selection drag ends on the backdrop). The shared `Modal` (`components/common/Modal`) enforces
this and has no overlay-click prop. New dialogs must use it. Standalone dialogs that can't, such
as the admin-portal modals, must not attach a close handler to their overlay and use the
`useEscapeKey` hook for Escape. `Modal.test.tsx` and `CredentialsModal.test.tsx` guard the rule.

## Documented exceptions

Two toolbars deliberately don't follow the panel button pattern:

- **Gantt header**: the project panel's header actions (staff and equipment toggle, tag filter,
  group by, column visibility, custom-column manager, import, new project) are compact 28 px
  buttons, mostly icon-only. The header sits above a dense timeline, where 36 px labelled buttons
  would take too much room. Keep them compact, and give each one a `title` and an accessible name.
- **Kanban filter toolbar** (`KanbanToolbar`): a single row of filter controls (project picker,
  tag filter, swimlane grouping, the **My Todo** toggle with `aria-pressed`, card count) with its
  own compact styling. It holds filters, not actions, so it doesn't use `PanelToolbar`.

## Mobile

Under 640 px, `styles/global.css` raises every `button` to a 44 px touch target, unless its class
name contains `badge`, `level`, `expandBtn`, `collapseBtn`, `dragHandle` or `wbsLevel`. Name a
deliberately compact inline control accordingly. Otherwise, expect it to grow on phones.
