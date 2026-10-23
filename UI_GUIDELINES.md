# Milestone Planner — UI Guidelines

> Codified rules for the Milestone frontend (`frontend/src`). The aim is **consistency**, not
> change: every value in this document is what the running app already uses, and where the code
> drifts from a rule the drift is listed as debt rather than hidden. Read this before any UI work;
> CLAUDE.md carries only one-line summaries that point here.

The structure follows the one used for Turbo EA's guidelines; the content is Milestone's own.

---

## 1. Principles

1. **CSS Modules + CSS variables, no UI library.** Every component has a co-located
   `X.module.css`; shared primitives live in `components/common/`. Don't add a component library.
2. **Semantic tokens, never raw values.** Colours, radii, shadows, font sizes, transitions and
   z-indexes are CSS custom properties in `src/styles/variables.css`. A component reads
   `var(--accent-red)`, never `#ef4444`.
3. **One source of truth per theme.** `variables.css` holds the default dark theme (`:root`) and
   the light theme; `styles/themes/themes.css` holds the two S-Theme variants. A token exists in
   every theme block or in none.
4. **Accessibility first.** Visible focus ring on everything, an accessible name on every icon-only
   control, `role="switch"` for toggles, 44 px touch targets on phones.
5. **Don't reinvent.** If a pattern exists (`Button`, `PanelToolbar`, `Modal`, `ToggleSwitch`,
   `Input`, `Select`, `AllocationSlider`, `ProjectFilterDropdown`, `ContextMenu`), use it.

---

## 2. Design tokens

All tokens are CSS custom properties defined in
[`frontend/src/styles/variables.css`](frontend/src/styles/variables.css) (default dark theme on
`:root`, light theme under `[data-theme="light"]`) and
[`frontend/src/styles/themes/themes.css`](frontend/src/styles/themes/themes.css) (the S-Theme
dark and light blocks). Components read them with `var(--name)`; JavaScript reads them only
through `utils/themeColors.ts` (`getCSSVariable`, `getPhaseColor`, `getDepthColor`).

The *Name* column is this guide's vocabulary for talking about a colour. The default theme's
values are exact [Tailwind](https://tailwindcss.com/docs/colors) palette stops where one exists
(Blue 500 = `#3b82f6`); the dark surfaces are Milestone's own and carry descriptive names. The
S-Theme has its own named palette (see 2.13). The token is what code uses.

A guard test, `src/styles/__tests__/cssTokens.test.ts`, fails CI when a stylesheet reads a
`var(--name)` that no stylesheet or inline style defines. A fallback value inside `var()` does not
exempt a token: the fallback hides a typo instead of fixing it.

### 2.1 Themes and switching

| Theme id | Family | Mode | Defined in |
| --- | --- | --- | --- |
| `dark` (default) | Default | dark | `variables.css` `:root` |
| `light` | Default | light | `variables.css` `[data-theme="light"]` |
| `s-theme-dark` | S-Theme | dark | `themes.css` |
| `s-theme-light` | S-Theme | light | `themes.css` |

- The theme is the `data-theme` attribute on `<html>`. `initTheme()` (`utils/storage.ts`) sets
  it before the first render so there is no flash; `setTheme()`, `toggleThemeMode()` (dark ↔
  light within the family) and `toggleTheme()` change it; the choice persists in
  `localStorage` under `STORAGE_KEYS.PREF_THEME`. The registry is `THEMES` / `THEME_FAMILIES`
  in the same file; a new theme is a new `[data-theme="…"]` block plus a `THEMES` entry.
- A component that needs the theme in JavaScript watches the attribute with a
  `MutationObserver` (`Header.tsx`, `ThemeToggle`, `LoginScreen`, `AdminDashboard`,
  `AdminLoginScreen` do this). Never read the stored preference directly.
- The S-Theme blocks override the font (Inter), the font-size scale (12 px minimum), radii and
  the whole palette; anything they don't override falls back to the `:root` dark value, so a
  token added to `:root` must be added to both S-Theme blocks too (and to `light`).
- `@media print` overrides the light theme to pure white, black text and no shadows.

### 2.2 Surfaces and borders

| Token | Name | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--bg-primary` | Midnight / White | `#0a0e14` | `#ffffff` | Page background |
| `--bg-secondary` | Deep navy / Slate 50 | `#111820` | `#f8fafc` | Sidebar, header, scrollbar track |
| `--bg-tertiary` | Dusk / Slate 100 | `#1a2332` | `#f1f5f9` | Inputs, table headers, raised panels |
| `--bg-card` | Graphite / White | `#151d2a` | `#ffffff` | Cards, modal body |
| `--bg-hover` | — | `rgba(255, 255, 255, 0.05)` | `rgba(0, 0, 0, 0.04)` | Row and item hover |
| `--bg-weekend` | — | `rgba(255, 255, 255, 0.05)` | `rgba(0, 0, 0, 0.06)` | Weekend columns in timelines |
| `--border-color` | Gunmetal / Slate 300 | `#2a3544` | `#cbd5e1` | **The** border. 323 uses |
| `--border-light` | Steel / Slate 200 | `#3a4554` | `#e2e8f0` | Lighter divider |
| `--border-subtle` | Gunmetal / Slate 200 | `#2a3544` | `#e2e8f0` | Hairline dividers inside dense lists |
| `--border-color-hover` | Steel hover / Slate 400 | `#3a4a5a` | `#94a3b8` | Border on hover |

`--border-default` and `--border-hover` are aliases of `--border-color` / `--border-color-hover`
kept for old stylesheets. New code uses `--border-color` and `--border-color-hover`.

### 2.3 Text

| Token | Name | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--text-primary` | Mist / Slate 900 | `#e8edf4` | `#0f172a` | Body text, headings |
| `--text-secondary` | Fog / Slate 700 | `#8b99ab` | `#334155` | Labels, secondary copy |
| `--text-tertiary` | Smoke / Slate 500 | `#6a7a8a` | `#64748b` | Captions |
| `--text-muted` | Ash / Slate 500 | `#5a6a7a` | `#64748b` | Placeholders, empty states, counts. 217 uses |
| `--text-disabled` | Ember / Slate 400 | `#4a5a6a` | `#94a3b8` | Disabled text |
| `--text-on-accent` | White | `#ffffff` | `#ffffff` | Text on a filled accent button |

### 2.4 Accents

| Token | Name | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--accent-blue` | Blue 500 / Blue 600 | `#3b82f6` | `#2563eb` | **The** accent: links, focus ring, selection, primary buttons. 208 uses |
| `--accent-blue-hover` | Blue 600 / Blue 700 | `#2563eb` | `#1d4ed8` | Hover on the accent |
| `--accent-blue-active` | Blue 700 / Blue 800 | `#1d4ed8` | `#1e40af` | Pressed state |
| `--accent-blue-dim` | Blue 600 / Blue 700 | `#2563eb` | `#1d4ed8` | Dimmed accent (badges) |
| `--accent-blue-alpha` | — | `rgba(59, 130, 246, 0.15)` | `rgba(37, 99, 235, 0.12)` | Tinted backgrounds, selected rows |
| `--accent-cyan` | Cyan 500 / Cyan 600 | `#06b6d4` | `#0891b2` | Link hover, secondary highlight |
| `--accent-green` | Emerald 500 / Emerald 600 | `#10b981` | `#059669` | Success, available, Done |
| `--accent-green-alpha` | — | `rgba(16, 185, 129, 0.15)` | `rgba(5, 150, 105, 0.1)` | Success tint (admin login notice) |
| `--accent-yellow` | Amber 500 / Amber 600 | `#f59e0b` | `#d97706` | Warnings, "hidden columns" state |
| `--accent-orange` | Orange 500 / Orange 600 | `#f97316` | `#ea580c` | Secondary warning, equipment booked |
| `--accent-red` | Red 500 / Red 600 | `#ef4444` | `#dc2626` | Errors, danger, Blocked, overdue. 82 uses |
| `--accent-red-hover` | Red 600 / Red 700 | `#dc2626` | `#b91c1c` | Danger button hover |
| `--accent-red-alpha` | — | `rgba(239, 68, 68, 0.15)` | `rgba(220, 38, 38, 0.1)` | Error boxes, danger tints |
| `--accent-purple` | Violet 500 / Violet 600 | `#8b5cf6` | `#7c3aed` | Custom columns, mentions |
| `--accent-teal` | Teal 500 / Teal 600 | `#14b8a6` | `#0d9488` | Equipment view badges |
| `--what-if-glow` | Azure | `#007AFE` | `#007AFE` | The pulsing What-If frame (`body.what-if-mode::before`) |

`--accent-primary` / `--accent-primary-hover` are aliases of the blue pair; new code uses
`--accent-blue`.

### 2.5 Status

Generic status colours and the Kanban board's column colours are two sets. The generic ones map
to the accents; the Kanban ones are their own tokens so a board can be re-coloured without
touching every error box.

| Token | Name | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--status-success` | Emerald | `#10b981` | `#059669` | Succeeded, healthy |
| `--status-warning` | Amber | `#f59e0b` | `#d97706` | Needs attention |
| `--status-error` | Red | `#ef4444` | `#dc2626` | Failed |
| `--status-info` | Blue | `#3b82f6` | `#2563eb` | Neutral information |

**Kanban status** (`CARD_STATUSES` in `utils/kanbanCards.ts`; labels from `STATUS_LABELS`:
*To Do*, *In Progress*, *Blocked*, *Done*):

| Token | Name | Dark | Light | Where it shows |
| --- | --- | --- | --- | --- |
| `--status-todo` | Slate 400 / Slate 500 | `#94a3b8` | `#64748b` | To Do column top border and dot |
| `--status-in-progress` | Blue | `#3b82f6` | `#2563eb` | In Progress column; **due-soon** chip |
| `--status-blocked` | Red | `#ef4444` | `#dc2626` | Blocked column; **overdue** chip |
| `--status-done` | Emerald | `#10b981` | `#059669` | Done column |
| `--status-todo-soft` | — | `rgba(148, 163, 184, 0.12)` | `rgba(100, 116, 139, 0.1)` | To Do header tint |
| `--status-in-progress-soft` | — | `rgba(59, 130, 246, 0.12)` | `rgba(37, 99, 235, 0.1)` | In Progress header tint, due-soon chip background |
| `--status-blocked-soft` | — | `rgba(239, 68, 68, 0.12)` | `rgba(220, 38, 38, 0.1)` | Blocked header tint, overdue chip background |
| `--status-done-soft` | — | `rgba(16, 185, 129, 0.12)` | `rgba(5, 150, 105, 0.1)` | Done header tint |

Used by `KanbanColumn`, `KanbanCard`, `KanbanCardModal`, `NotificationBell` and
`MentionTextarea`. A card's 3 px left border is the card's own phase colour, not a status token.

### 2.6 Phase and level colours

A new phase gets `getPhaseColor()` and a new subphase `getDepthColor(depth)`
(`utils/themeColors.ts`, read from the active theme at creation time; `PhaseModal`,
`SubphaseModal`). The colour is then **saved on the item**, so a theme switch recolours only
items created afterwards. The transform layer injects the same helpers when it builds the tree.

| Token | Name | Value (dark and light) | Use |
| --- | --- | --- | --- |
| `--level-phase` | Pink | `#FF50A8` | Top-level phases |
| `--level-1` | Cyan | `#05B6D4` | First subphase level |
| `--level-2` | Purple | `#8B5CF6` | Second level |
| `--level-3` | Blue | `#3B82F6` | Third level |
| `--level-4` | Orange | `#FA7315` | Fourth level |
| `--level-5` | Emerald | `#11B981` | Fifth level |
| `--level-6` | Fuchsia | `#EC4899` | Sixth level |
| `--level-7` | Amber | `#EAB30A` | Seventh level |
| `--level-8` | Teal | `#14B8A6` | Eighth level |
| `--level-9` | Violet | `#A755F7` | Ninth level |
| `--level-10` | Rose | `#F43F5E` | Tenth level (deeper levels wrap) |
| `--level-bar-text` | White | `#ffffff` | Text on level bars (defined; currently unused) |
| `--progress-line-color` | — | `rgba(255,255,255,.9)` dark / `rgba(0,0,0,.4)` light | Completion line on a bar |

The light theme does not override the level colours. The default predefined-phase set has its
own tokens, used only as seed colours:

| Token | Name | Dark | Light |
| --- | --- | --- | --- |
| `--phase-preparation` | Amethyst / Violet 600 | `#9b59b6` | `#7c3aed` |
| `--phase-analytics` | River blue / Blue 600 | `#3498db` | `#2563eb` |
| `--phase-trial` | Carrot / Orange 600 | `#e67e22` | `#ea580c` |
| `--phase-cleaning` | Turquoise / Teal 600 | `#1abc9c` | `#0d9488` |
| `--phase-report` | Nephritis / Emerald 600 | `#27ae60` | `#059669` |

User-picked marker colours (company events, absence types) come from
`EVENT_COLOR_SWATCHES` in `utils/colorSwatches.ts`: Red `#ef4444`, Orange `#f97316`, Yellow
`#f59e0b`, Green `#10b981`, Cyan `#06b6d4`, Blue `#3b82f6`, Purple `#8b5cf6` (the accent values
of the default dark theme). The first, red, is `DEFAULT_EVENT_COLOR`.

### 2.7 Component tokens

| Token | Name | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| `--btn-primary-bg` | Blue 500 / Blue 600 | `#3b82f6` | `#2563eb` | Primary button fill |
| `--btn-primary-hover` | Blue 600 / Blue 700 | `#2563eb` | `#1d4ed8` | Primary button hover |
| `--btn-primary-text` | White | `#ffffff` | `#ffffff` | Primary button label |
| `--btn-secondary-bg` | — | `transparent` | `transparent` | Secondary button fill |
| `--btn-secondary-border` | Gunmetal / Slate 300 | `#2a3544` | `#cbd5e1` | Secondary button border |
| `--btn-secondary-hover` | — | `rgba(59, 130, 246, 0.1)` | `rgba(37, 99, 235, 0.08)` | Secondary button hover tint |
| `--input-bg` | Dusk / White | `#1a2332` | `#ffffff` | Input background |
| `--input-border` | Gunmetal / Slate 300 | `#2a3544` | `#cbd5e1` | Input border |
| `--input-focus-border` | Blue | `#3b82f6` | `#2563eb` | Focused input border |
| `--input-focus-shadow` | — | `rgba(59, 130, 246, 0.2)` | `rgba(37, 99, 235, 0.15)` | Focus ring around inputs |
| `--table-header-bg` | Dusk / Slate 50 | `#1a2332` | `#f8fafc` | Table header row |
| `--table-row-hover` | — | `rgba(59, 130, 246, 0.05)` | `rgba(37, 99, 235, 0.04)` | Row hover |
| `--table-row-selected` | — | `rgba(59, 130, 246, 0.1)` | `rgba(37, 99, 235, 0.08)` | Selected row |
| `--table-border` | Gunmetal / Slate 200 | `#2a3544` | `#e2e8f0` | Table lines |
| `--modal-backdrop` | — | `rgba(0, 0, 0, 0.75)` | `rgba(15, 23, 42, 0.5)` | Dimmed page behind a modal |
| `--modal-bg` | Graphite / White | `#151d2a` | `#ffffff` | Modal surface |
| `--modal-border` | Gunmetal / Slate 200 | `#2a3544` | `#e2e8f0` | Modal border |
| `--scrollbar-track` | Deep navy / Slate 50 | `#111820` | `#f8fafc` | Scrollbar track |
| `--scrollbar-thumb` | Steel / Slate 300 | `#3a4554` | `#cbd5e1` | Scrollbar thumb |
| `--scrollbar-thumb-hover` | Ash / Slate 400 | `#5a6a7a` | `#94a3b8` | Scrollbar thumb hover |
| `--header-bg` | Deep navy / Slate 50 | `#111820` | `#f8fafc` | App header |
| `--header-border` | Gunmetal / Slate 200 | `#2a3544` | `#e2e8f0` | App header bottom border |

### 2.8 Radius and shadows

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | 4 px | Chips, small badges, timeline markers. 96 uses |
| `--radius-md` | 8 px | Buttons, inputs, cards, panels. 153 uses |
| `--radius-lg` | 12 px | Modals, large cards |
| `--radius-full` | 9999 px | Pills, avatars, switches |
| `--shadow-sm` | `0 2px 4px rgba(0, 0, 0, 0.2)` dark / `0 1px 2px rgba(0, 0, 0, 0.05)` light | Raised rows, chips |
| `--shadow-md` | `0 4px 12px rgba(0, 0, 0, 0.4)` / `0 2px 8px rgba(0, 0, 0, 0.08)` | Dropdowns, popovers |
| `--shadow-lg` | `0 8px 24px rgba(0, 0, 0, 0.5)` / `0 4px 16px rgba(0, 0, 0, 0.1)` | Modals |
| `--shadow-xl` | `0 16px 48px rgba(0, 0, 0, 0.6)` / `0 8px 32px rgba(0, 0, 0, 0.12)` | The Settings hub |

The S-Theme uses 3 / 6 / 8 px radii.

### 2.9 Spacing and layout dimensions

There is **no spacing token scale** in the default theme. Spacing is written in rem multiples:
`0.25rem`, `0.375rem` (label-to-control), `0.5rem` (between buttons), `0.75rem` (toolbar
padding), `1rem` (between form groups, toolbar slots), `1.5rem`. The `--spacing-*` variables in
the S-Theme blocks are not read by any stylesheet; don't start using them without adding them to
the default theme.

| Token | Value | Mobile (≤ 640 px) |
| --- | --- | --- |
| `--header-height` | 56 px | 48 px |
| `--sidebar-width` / `--sidebar-collapsed-width` | 240 px / 56 px | 100 % |
| `--resource-panel-width` | 280 px | 100 % |
| `--project-panel-width` | 320 px | 100 % |
| `--row-height` (Gantt project row) | 44 px | 40 px |
| `--detail-row-height` (phase / subphase / assignment row) | 32 px | 28 px |
| `--section-row-height` (Group-by section header) | 36 px + 1 px border = `SECTION_ROW_TOTAL_HEIGHT` (37) in `rowPositions.ts` | same |
| `--timeline-header-height` | 40 px | same |

### 2.10 Typography

Font: `--font-family` = DM Sans, system fallbacks (S-Theme: Inter). `html` is 16 px; `body`
uses `--font-size-base` and `--line-height-normal`.

| Token | Default | S-Theme | Use |
| --- | --- | --- | --- |
| `--font-size-xs` | 11 px | 12 px | Badges, timeline cells, row metadata. 88 uses |
| `--font-size-sm` | 12 px | 12 px | Buttons `md`, table text, most UI copy. 119 uses |
| `--font-size-md` | 13 px | 12 px | Dense body copy |
| `--font-size-base` | 14 px | 14 px | Body, inputs, `lg` buttons |
| `--font-size-lg` | 16 px | 16 px | `h3` |
| `--font-size-xl` | 18 px | 18 px | `h2`, modal titles |
| `--font-size-2xl` | 24 px | 24 px | `h1` |
| `--font-size-3xl` | 30 px | 32 px | Login title |

Weights `--font-weight-normal` 400, `--font-weight-medium` 500 (buttons, labels),
`--font-weight-semibold` 600 (headings), `--font-weight-bold` 700. Line heights
`--line-height-tight` 1.25, `--line-height-normal` 1.5, `--line-height-relaxed` 1.75. Headings
are semibold, tight, `--text-primary`; links are `--accent-blue`, hover `--accent-cyan`, no
underline.

### 2.11 Transitions and z-index

| Token | Value | Use |
| --- | --- | --- |
| `--transition-fast` | 0.1 s ease | Hover and focus colour changes (the default; 175 uses) |
| `--transition-normal` | 0.2 s ease | Panel collapse, dropdown open |
| `--transition-slow` | 0.3 s ease | Large layout changes |
| `--z-dropdown` | 100 | Dropdowns, popovers, context menus |
| `--z-sticky` | 200 | Sticky headers inside scroll areas |
| `--z-header` | 500 | App header |
| `--z-popover` | 600 | `AnchoredPanel` (portaled dropdown panels): above the app header, below a modal backdrop |
| `--z-modal-backdrop` / `--z-modal` | 1000 / 1001 | Modal layer |
| `--z-tooltip` | 2000 | Tooltips, the Shift-hover date tooltip |
| `--z-what-if-border` / `--z-what-if-banner` | 9999 / 10000 | What-If frame and banner, above everything |

Debt: 103 raw `z-index` literals versus 14 token reads. New code uses the scale.

### 2.12 Breakpoints

| Range | Name | What changes |
| --- | --- | --- |
| ≤ 640 px | Mobile | Panels go full width, rows shrink (2.9), body 13 px, 44 px touch targets (§7) |
| 641–1024 px | Tablet | Narrower panels |
| > 1024 px | Desktop | Full layout |

The header does not use these. Its four density tiers (`full` ≥ 1600, `compact` ≥ 1280,
`condensed` ≥ 1024, `minimal` below) are defined once in `hooks/useHeaderDensity.ts` and applied
as `data-density` (§3.11). Every other `@media` width in a stylesheet is 640 or 1024 px — don't
add an off-scale one.

### 2.13 The S-Theme palette

The S-Theme (`themes.css`) is a navy-and-blue family with Inter and an 8 px grid. Its colours are
named in the stylesheet comments; the names below are those.

| Role | S-Theme Dark | S-Theme Light |
| --- | --- | --- |
| Surfaces | navy `#0a0f1a` / `#111827` / `#1a2744`, card `#151d2e` | Snow `#ffffff`, Fog `#f0f6ff`, Cloud `#d0e0f2` |
| Borders | blue-tinted `#2a3a5a` / `#364064` / `#243352` | Smoke `#c9d1d8`, Cloud `#d0e0f2`, Rain `#abbfd5` (hover) |
| Text | Fog `#f0f6ff`, Rain `#abbfd5`, Cobalt `#7c9cbf`, Stone `#6b7896`, Iron `#585e76` | Black `#000000`, Night `#353535`, Coal `#585858`, Grey `#82868b`, Rock `#a7a7a7`; titles Granite `#364064` |
| Primary accent | Water `#3c8bff` (hover `#5a9fff`, active `#70acff`) | Blueberry `#002eff` (Ocean `#0062f2` hover, Navy `#001478` active, Indigo `#001b9a` dim) |
| Secondary accents | Bondi `#00c8ff`, Forest `#30a52d`, Lemon `#ffda3a`, Fire `#f18100`, Cherry `#ff4d4d`, purple `#a855f7` | River `#0076de`, Forest `#30a52d`, Beer `#ffb443`, Fire `#f18100`, Ruby `#ce1618` (Cherry `#ea5455` hover), Violet `#8f0098` |
| Level colours (both) | Rose `#D63384`, River `#0076DE`, Gem `#6610F2`, Bondi `#00C8FF`, Sun `#FF9F43`, Moss `#20C997`, Lotus `#D633CF`, Beer `#FFB443`, Berry `#7367F0`, Cherry `#EA5455`, Lilac `#A990DD` | same |
| Status | Forest / Fire / Ruby / Ocean | same |

The S-Theme also defines `--text-title`, `--input-placeholder` and `--spacing-*`, which the
default theme lacks; nothing reads them today.

---

## 3. Layout patterns

### 3.1 App shell

`MainLayout` = `Header` (56 px, `--header-bg`) over a row of `Sidebar` (240 px, collapsible to
56) · the current view · `ResourcePanel` (280 px, staff/equipment cards to drag onto the Gantt).
Views are `viewStore.currentView` state, not routes. The Settings hub is a `wide` `Modal`
(§3.5) with a grouped section list on the left and one `…Panel` on the right; every admin screen
is a panel in that hub, never a new sidebar item.

Global styles (`styles/global.css`) set the base typography, the native input look (`10px 12px`
padding, `--bg-tertiary`, `--border-color`, `--radius-md`, blue focus ring), `button` resets
(no border, no background, medium weight, `opacity: .5` when disabled), the scrollbar, text
selection, the `:focus-visible` ring (2 px `--accent-blue`, 2 px offset), the What-If frame
(`body.what-if-mode::before`, a pulsing 3 px `--what-if-glow` border), and the mobile and
coarse-pointer rules (§7).

### 3.2 Buttons

Every action button is the shared `Button` (`components/common/Button`). Don't write a raw
`<button>` with local styles for an action. Raw buttons are fine for controls that are not
actions: option chips, tabs, colour swatches, clickable list rows, and the compact row icons in
§3.3.

```tsx
import { Button } from '@/components/common/Button';
import { Icon, PlusIcon } from '@/components/common/Icon';

<Button icon={<Icon icon={PlusIcon} />} onClick={handleCreate}>
  Add holiday
</Button>
```

**Variants**

| Variant | Looks like | Use it for |
| --- | --- | --- |
| `primary` (default) | Solid blue | The main action of a panel or dialog: **Add X**, **Create X**, **Save Changes**. At most one per toolbar or footer. |
| `secondary` | Bordered, neutral | Every other action next to the primary one: **Manage Skills**, **Import .ics**, **Export .ics**, **Refresh**, **Cancel**, **Close**. |
| `ghost` | Text only, background on hover | Back links (**Back to list**, **All sites**), low-emphasis actions inside rows, the admin-portal **Logout**. |
| `danger` | Solid red | The **Delete** action in an edit dialog's footer, placed far left (PhaseModal, SubphaseModal, AssignmentModal, EquipmentBlockModal, CustomColumnModal, UsersPanel). The confirmation itself is the shared confirm dialog (§3.12), whose `destructive` button is this variant. |
| `icon` | Square, transparent | An icon-only button with an `aria-label`. Available but **unused today**: the existing icon-only buttons are raw (§3.3). |

**Sizes**

| Size | Height | Padding / font | Use it for |
| --- | --- | --- | --- |
| `md` (default) | 36 px | `0 1rem`, `--font-size-sm` | Everything: toolbars, add rows, back links, dialog footers. The Settings add-row inputs are 36 px too, so they line up. |
| `sm` | 28 px | `0 0.75rem`, `--font-size-xs` | Only for actions repeated on every row of a dense list (**Edit** / **Delete** in *My absences*). |
| `lg` | 44 px | `0 1.5rem`, `--font-size-base` | Large standalone calls to action: the sign-in buttons of both login screens (`className={styles.fullWidth}` stretches them to the card). |

Don't use `sm` in a toolbar. A small primary button next to medium ones was the drift this
guide was written to stop.

**Icons.** Pass icons through the `icon` prop (`iconPosition="right"` puts it after the label).
The button sizes the svg — 14 px in `md`, 12 px in `sm`, 20 px in `lg`, whatever `size` the `Icon`
was given — and the icon inherits the text colour through `currentColor`. Don't put an icon with a
hand-tuned margin in the children.

**States.** `disabled` dims to 50 % opacity (the global `button:disabled` rule). `loading` is
**the** way to show an in-flight write: `<Button loading={isSubmitting}>Save Changes</Button>`
shows the spinner over the label, disables the button and sets `aria-busy`. The label never
changes, so a test selects the button by its resting name and asserts `aria-busy`. Don't swap
the label (`isSubmitting ? 'Saving...' : 'Save Changes'` was the old convention; none is left).
Inside a `<form>`, set `type="button"` on every button that must not
submit (back links, Cancel) and `type="submit"` on the one that does, as the Tags and Absence
types add rows do; Enter in the input then submits.

Writes from a dialog or a Settings panel are guarded with `useSubmitGuard`
(`components/common/useSubmitGuard.ts`, 30 files) so Enter-twice or a double click cannot create
duplicates; its `isSubmitting` is what feeds `loading`. One guard per dialog: `KanbanCardModal`
shares it between moves and assignments, so no two writes on a card overlap; its comment thread is
`CardComments`, which carries its own guard and error `Notice`. The booking dialog renders the same
thread after its `<form>`, never inside it: the shared `Button` has no default `type`, so a Comment
click inside a form would submit and close the dialog (every button in `CardComments` is
`type="button"` as well). The test
for a guard fires both clicks inside one `act()` (React batches the first click's state update,
so the button is still enabled for the second) and asserts one API call.

### 3.3 Panel toolbar, back links and row actions

**Panel toolbar.** Every Settings panel with a toolbar uses `PanelToolbar`
(`components/settings/PanelToolbar.tsx`). Filters, counts or a search field go in `left`; the
panel's actions in `right`, secondary first and the primary **Add X** last. A divider sits under
it.

```tsx
<PanelToolbar
  left={<span className={styles.count}>{users.length} users</span>}
  right={
    canManage && (
      <>
        <Button variant="secondary" icon={<GearIcon />} onClick={openSkills}>Manage Skills</Button>
        <Button icon={<PlusIcon />} onClick={handleCreate}>Add User</Button>
      </>
    )
  }
/>
```

- Either slot may be left out; a `false` / `null` slot (a role-gated action) renders nothing and
  the actions stay on the right.
- `align="end"` bottom-aligns both slots. Use it when the left slot holds labelled fields (a
  label stacked above a select, as in Bank holidays, Company events and Equipment).
- The layout is a flex row, `space-between`, 1 rem gap, wrapping, `0.75rem` padding above a
  1 px `--border-color` divider and `0.75rem` margin below it; the actions are `0.5rem` apart.
  Don't redefine any of this in a panel's CSS module.

Panels without a toolbar keep their add control next to the input it belongs to (Sites,
Predefined phases, Tags, Absence types). That control is still a `md` primary `Button` with
`PlusIcon`.

**Back links.** A view that replaces a list (an edit form, an import view) has a back link at
its top: a ghost `md` `Button` with `BackIcon`, labelled with where it goes (**Back to list**,
**Back to holidays**, **All sites**; the admin portal's **Back to Application**). Don't use a text
arrow or a styled link.

**Row actions.** Edit, delete and similar actions repeated on every row are compact **28 px**
icon-only buttons (`.iconBtn` / `.actionBtn` / `.editBtn` in the panel's module) with
the §3.14 icon at its row size, each with an `aria-label` that names the row (`Delete ISO
Audit`) and usually a `title`. They stay compact so a long list remains scannable. The inline
confirm/cancel pairs (`UsersPanel`, `EquipmentPanel` inline type/skill add) are 28 px too, named
**Add type** / **Cancel adding a type**. Debt: *My absences* uses text `ghost sm` buttons. None
of these class names is on the mobile exclusion list, so on phones they grow to 44 px (§7) — a
decision, not an oversight.

### 3.4 Forms

- **`Input`** (`components/common/Input`): `label`, `error`, `hint`, `leftIcon`, `rightIcon`,
  `fullWidth`, plus every native input prop. 36 px tall; the label is linked through `htmlFor`
  (an id is generated when none is given); an `error` replaces the `hint`, sets `aria-invalid`
  and is announced (`role="alert"`, linked through `aria-describedby`; a `hint` is linked the
  same way).
- **Two fields side by side** (a start/end date pair): a grid of `minmax(0, 1fr) minmax(0, 1fr)`
  (or a flex row whose items have `min-width: 0`), never `1fr 1fr`. A `1fr` track cannot shrink
  below its content, so a wide field overflows its neighbour on a narrow dialog. The token test
  rejects a bare `1fr` track in a module stylesheet.
- **`DateRangeField`** / **`DateField`** (`components/common/DateRangeField`): every model date
  is entered through them — never a raw `type="date"` input. `DateRangeField` is a start and an
  end on one two-month calendar (one month at ≤ 640 px): two read-only `Input`s with
  `role="combobox"` (`startLabel` / `endLabel`, `start` / `end` as `YYYY-MM-DD` or `''`) that open
  the panel on a click or on Enter / Space / ArrowDown — plain focus never does, so Tab passes
  through a form. The first click sets the start, the next the end; a start after the end moves
  the end and keeps the duration, an end before the start becomes the new start, so the end can
  never precede it. `onChange({ start, end })` fires once per click. `endOptional` +
  `endPlaceholder` (*Same day*) make the end clearable (*Clear end date*, Backspace) for bank
  holidays and company events; `separator` sits between the fields, `fieldClassName` is each
  field's grid-item class (the wrapper is `display: contents`, so the fields stay items of the
  consumer's `.formRow`). `DateField` is the single date (milestone date):
  `value`, `onChange`, `label`, `fullWidth`. Both share `disabled`,
  `highlightWeekdays` (the recurring absence's days) and `markSiteCalendar` (default true): weeks
  start on Monday, weekends are muted and the header site's bank holidays and closures carry a dot,
  a tooltip and a note in the day's accessible name, all from `appStore`; the Settings holiday and
  event forms pass `markSiteCalendar={false}` because they may edit another site. The field text
  is `formatMediumDate` (`22 Oct 2026`, browser locale); tests read the ISO value from
  `data-value` through the helpers in `src/test/datePicker.ts`. The calendar is
  `react-day-picker`, themed by **setting** its `--rdp-*` properties from app tokens in
  `DateRangeField.module.css` (never read one: the token test would misread the name).
- **`Select`** (`components/common/Select`): `options: {value, label, disabled?}[]`,
  `groups: {label, options}[]` (labelled `<optgroup>`s after the flat options — the site
  form's countries by region), `placeholder` (rendered as a *disabled* empty option, so only
  for a choice the user must replace; a selectable "none" is a normal `options` entry),
  `icon`, `label`, `error`, `hint`, `fullWidth`. 36 px.
- **`MultiSelectDropdown`** (`components/common/MultiSelectDropdown`): several items of a short
  coloured list in a box that looks like `Select` (the project dialog's multi-select project
  fields). `label`, `options: {id, name, color?}[]`, `selectedIds`, `onChange(ids in item order)`,
  `disabled`, `placeholder` (*None*), `emptyText`. The trigger is a `<button>`
  (`aria-haspopup="listbox"`, named by the label and the chosen names); the panel is a
  `role="listbox"` `aria-multiselectable` of `role="option"` rows (checkbox glyph, colour dot,
  name) that stays open while items are ticked, with a **Clear** row, and closes through
  `useDismissableOverlay`. `searchable` adds the search box of `SearchableSelect` above the rows
  (focused on open and after Clear; the rows filter on `name` and an optional per-item `hint`;
  Enter ticks the active row and keeps the panel open; Space types), `summary(chosen)` replaces
  the joined names in the trigger (*5 members*) and `allowClear={false}` drops the Clear row —
  the team member list in Settings → Teams uses all three, with the chosen members listed under
  it, each with a × button. Tags keep their pills (`TagPicker` over `OptionPicker`).
- **`SearchableSelect`** (`components/common/SearchableSelect`): pick one item of **any list of
  people, or any list longer than a handful** (project manager, booking dialog staff or
  equipment, Kanban *Add someone…*, absence staff); `Select` stays for short fixed choices.
  `label` (or `aria-label` for a hidden one), `options: {id, label, hint?, note?, disabled?}[]`,
  `value: number | null`, `onChange(id)` (only on a real change, like a native select),
  `emptyLabel` (a first row that picks `null`), `placeholder`, `disabled`, `title`, `className`
  (on the wrapper). The trigger looks like the `Select` box; the panel opens under it with a
  focused search `Input` (`role="combobox"`, `aria-activedescendant` on it) over a
  `role="listbox"` whose rows show the label, a muted `hint` (searched: job title, equipment
  type) and a muted `note` (not searched: *80% capacity*). Filtering starts at the first
  character; a printable key on the closed trigger opens it with that character typed; Enter
  picks the active row and never submits a host form; Escape, Tab out and an outside mousedown
  close it through `useDismissableOverlay`. The list is 14 rem tall and the panel scrolls itself
  into view on open. Tests use the helpers in `src/test/searchableSelect.ts` (`pickOption`,
  `pickerOptions`, `pickerSearch`).
- **`ToggleSwitch`** (`components/common/ToggleSwitch`): every on/off flag, in Settings and in
  dialogs alike. A visually hidden checkbox with `role="switch"`, so keyboard, screen-reader and
  label behaviour come for free; pass `label` for visible text (a `ReactNode`, so an icon may sit
  in it, as the absence dialog's *Recurring Absence* does) or `aria-label` when there is none.
  Every boolean uses it: the settings flags (General, Tags, SSO incl. auto-create, Absence types,
  the Active flags of sites, users and equipment, the site-closure flag, *Show inactive*), the
  entity flags in dialogs (Project *Confirmed* / *Archived*, phase and subphase *Milestone*,
  *Global column*, *Recurring Absence*) and the organization SSO flags in the admin portal. A
  raw checkbox is right only for **picking several items from a list**: the tag, type, role and
  skill filters, column visibility, the `.ics` import rows, `SiteChecklist`, the equipment
  site picker, the header team filter (`TeamSelector`), `TeamChecklist` (project teams and the
  teams a tag, piece of equipment or company event is limited to). A "limit to teams" choice per site is a *Whole site* switch over a
  `TeamChecklist` (`TeamScope`). Tests reach a switch with `getByRole('switch', { name })`.
- **`RoleChecklist`** (`components/common/RoleChecklist`): the roles that may approve a request
  (Settings → Roles → Approvals). Same shape as `TeamChecklist` without colours: a labelled
  `role="group"` of label-wrapped checkboxes. The Administrator role is always ticked, disabled
  and suffixed *(always)*, and never appears in `onChange`'s output.
- **`Notice`** (`components/common/Notice`): the one inline message box. `tone` = `error` |
  `warning` | `info` | `success` (accent token text and border on its alpha tint, `0.75rem 1rem`,
  `--radius-md`); `role` defaults to `alert` for errors and `status` otherwise; `onDismiss` adds a
  labelled close button; `className` / `style` for spacing. Every settings panel and admin modal
  renders its error through it. For an action with no form of its own (a context-menu delete, a
  refused dependency link, a Kanban move the server rejected) call `uiStore.showFlash(message,
  tone)`: `layout/FlashNotice` renders it bottom-right above the activity feed and clears it after
  6 s or on Dismiss.
- **`ColorSwatchPicker`** (`components/settings/panels/ColorSwatchPicker`): the one colour
  picker — a `role="radiogroup"` (`label`) of round 28 px `role="radio"` swatches named after
  their colour (`EVENT_COLOR_SWATCHES` by default, `swatches` for another palette such as
  `SKILL_COLOR_SWATCHES`), with `allowCustom` for a native colour input behind a dashed "+".
  On touch devices it grows to 40 × 40 so the swatches stay round under the global 40 px
  touch rule. Used by Tags, Absence types, Company events, Skills and Teams
  (`TEAM_COLOR_SWATCHES`). Never hand-roll a row of
  coloured buttons: the Skills panel had its own copy, which the touch rule stretched into
  ovals on iPad because only the height was raised.
- **`AllocationSlider`** (`components/common/AllocationSlider`): the one control for a staff
  allocation, on the Gantt and the Kanban card. 5 % steps from 5 to 100; `onChange` fires on
  every step and `onCommit` once on release, so a caller that saves listens to `onCommit` only.
  It warns above `maxCapacity` and has a `compact` variant for list rows.
- **`MentionTextarea`** / `MentionText` (`components/common/MentionTextarea`): the comment
  composer and renderer. A real `<textarea>` with an ARIA listbox for `@` suggestions; both build
  their output from React children and never use `dangerouslySetInnerHTML`.
- **Dialog form layout** (`PhaseModal.module.css` is the reference): `.form` is a flex column
  with a 1 rem gap; `.formGroup` stacks label and control with `0.375rem`; `.formRow` is a
  two-column grid with a 1 rem gap; labels are `--text-secondary`, weight 500. Settings panels
  report unsaved input with `useReportDirty(onDirtyChange, dirty)` so the hub asks before
  switching section or closing.
- **Every text-like field and every dropdown is `Input` / `Select`** — dialogs, Settings panels,
  the admin-portal modals and both login screens included; no component styles its own `.input`
  any more. Both generate a stable id with `useId` when none is passed, so the label link never
  churns. The documented exceptions, and the only raw controls left, are: the inline row-rename
  editors inside list rows (Tags, Absence types, Predefined phases — 32 px, no label), the two
  ARIA comboboxes with their own listbox (the Users panel job-title autocomplete, the `TagPicker`
  search), the Gantt `CustomColumnCell` editor (a table cell), the header `SiteSelector` (styled
  by density tier), the `SettingsHub` phone-only section picker and the read-only copy fields of
  `CredentialsModal`. `src/components/__tests__/rawFormControls.test.ts` pins them: it counts
  text-like `<input>`s and `<select>`s per component against `rawFormControlsAllowlist.json`, a
  count may only go down, and the allowlist must not name a file that no longer needs it.
  Checkboxes, radios, ranges, file and colour inputs are native and not Input's job.
- **Native controls follow the theme.** `color-scheme` is set once per theme block in
  `styles/variables.css` / `themes.css` (`dark` or `light`), so the scrollbars and the remaining
  native controls match the theme everywhere. Never set `color-scheme` in a component stylesheet.

### 3.5 Modals and dialogs

Modals close **only** through an explicit button or the Escape key. They never close on a
backdrop or outside click, because that would discard in-progress input (for example when a
text-selection drag ends on the backdrop). The shared `Modal` (`components/common/Modal`)
enforces this and has no overlay-click prop; `Modal.test.tsx` and `CredentialsModal.test.tsx`
guard the rule.

- Props: `isOpen`, `onClose`, `title`, `size`, `footer`, `closeOnEscape` (default true),
  `flushBody` (drop the body padding so the content lays out its own panes — the Settings hub).
- Sizes: `sm` 360 px, `md` 480 (default), `lg` 640, `xl` 800, `xxl` 1000, `wide` =
  `min(100vw - 2rem, 1360px)` × up to 900 px for the Settings hub.
- Footer order: a `danger` **Delete** far left (edit mode only), then on the right **Cancel**
  (`secondary`) and the primary last — **Save Changes** when editing, **Add X** / **Create X** /
  **Assign X** when creating. A view-only dialog has a single secondary **Close**. The shared
  footer is `flex-end` with a `0.75rem` gap. Debt: `ProjectModal` puts export buttons on the
  left, `CustomColumnModal` / `CustomColumnsManagerModal` use a ghost Cancel/Close.
- App dialogs open through `uiStore.openModal` and render in `ModalContainer`; that registration
  is what makes `useKeyboardShortcuts` stand down while a dialog is open. Known gap: the
  custom-column dialogs are opened from local state in `ProjectPanel`, so shortcuts stay live
  behind them.
- Escape reaches the innermost `Modal` only: the document listener acts for the top of the
  open-modal stack, so a confirm over the Settings hub closes alone. A parent that opens a child
  that is *not* a `Modal` passes `closeOnEscape={!childOpen}` for the same effect. A picker
  *inside* a modal (`TagPicker`, the `MentionTextarea` suggestion list) handles Escape in its
  React `onKeyDown` and calls `stopPropagation()` for the same reason.
- `modalContext.returnTo` reopens the previous dialog when a chained one closes (My absences →
  absence dialog). Unsaved changes are guarded with `onDirtyChange` + `confirmAction()`
  (`SettingsHub`, whose `onClose` is async).
- The container receives focus on open (`tabIndex={-1}`); Tab and Shift+Tab cycle inside the
  **innermost** open dialog (a module-level stack of open containers — a nested dialog is
  portaled to `<body>`, outside its parent, so only the top one traps); the element that had
  focus before the dialog opened gets it back on close; the title id comes from `useId`, so
  nested dialogs don't collide. Every mounted `Modal` reports itself to `uiStore.openModalCount`
  (`modalOpened` / `modalClosed`), which is how the global shortcuts stand down for dialogs that
  are opened through local state rather than `activeModal` (the custom-column dialogs).
- Standalone dialogs that can't use `Modal` — the admin-portal modals in
  `components/admin/modals/` — must not attach a close handler to their overlay and use the
  `useEscapeKey` hook (`src/hooks/useEscapeKey.ts`) for Escape (it stands down while a
  confirmation is open, so Escape there closes only the confirm), and carry `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby` pointing at their `<h2>` (a `useId`) and a close button
  named **Close dialog**.

### 3.6 Dropdowns, popovers and context menus

A new non-modal overlay (dropdown, filter panel, popover, context menu) closes:

- on a `mousedown` outside the trigger and panel,
- when focus leaves the wrapper (Tab out), and
- on Escape — listened for in the capture phase with propagation stopped, so the key closes only
  this panel and never reaches the app-wide shortcuts — after which focus returns to the trigger.

All three come from one hook, `useDismissableOverlay({ open, onClose, wrapperRef, triggerRef?, panelRef? })`
(`src/hooks/useDismissableOverlay.ts`), which returns the `onBlur` to put on the wrapper; pass
`panelRef` when the panel is portaled out of the wrapper (see `AnchoredPanel` below). While a
confirmation (§3.12) is pending the hook is inert: the confirm owns Escape and the overlay that
asked (e.g. the dependency popover) stays open until the answer. Never
hand-roll a click-outside effect. `ProjectFilterDropdown` and `FieldChoiceDropdown` are the
reference users; the header overflow menu, `UserMenu`, the Panels dropdown, the header `TeamSelector`, `NotificationBell`
(which also `aria-controls` its panel), the `ProjectPanel` column-visibility dropdown,
`CustomColumnHeader` filters, the Staff and Equipment view filters, `DependencyPopup` and
`ContextMenu` all use it. A panel with checkboxes or radios is a non-modal `role="dialog"` (not
a `menu`) with an `aria-label`; its trigger carries `aria-expanded` and `aria-haspopup="dialog"`.
A dropdown panel outside a Modal that a clipping pane could cut off (the Gantt header's Filter,
Group by, Colour by and column menus while an overview panel is open, the Staff / Equipment
overview filters) is an `AnchoredPanel` (`components/common/AnchoredPanel`): portaled to `<body>`,
`position: fixed` under the trigger (or above it when the room below is short), `align`
`start` / `end`, its `max-height` the measured room minus 16 px so the panel's own list scrolls,
`z-index: var(--z-popover)` (above the app header, so a panel flipped up to the viewport top is
not hidden under it; below a modal backdrop). Only the panel moves — the trigger keeps its place and its
`aria-expanded` / `aria-haspopup`, Tab from the trigger enters the panel and Tab from its end goes
on to the element after the trigger. Its caller passes the panel's ref as `panelRef`; its class
draws the panel and never sets position, inset or z-index. A popover that must escape a scrolling
Modal body (the date picker panel) is `position: fixed` but rendered inside its trigger's wrapper,
never in a portal: staying in the Modal's DOM subtree keeps the Tab trap, `aria-modal` and
`useDismissableOverlay`'s `wrapperRef.contains` working.

`ContextMenu` (`components/common/ContextMenu`) is the right-click menu: a `role="menu"` of
`role="menuitem"` buttons (tests select them by that role); items take `danger`, `divider`,
`disabled` plus a `title` giving the reason, and the menu keeps itself inside the viewport.

### 3.7 Tags and pills

Tags are rounded pills filled with the tag colour. The text colour always comes from
`barTextColor(tag.color)` (`utils/tags.ts`): white or near-black, whichever contrasts more, so
a pill stays readable on light colours. Don't hard-code `color: white` on a coloured background:
`PhaseBar` and `ProjectBar` set their text colour inline from `barTextColor(color)` too (the
`.darkText` class drops the label shadow).

```tsx
<span className={styles.pill} style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}>
  {tag.name}
</span>
```

Resolve a tag's colour and group through `appStore.tags` / `tagGroups` by id (`indexTags`), never
from the inline `project.tags[].color`, which is stale during What-If.

### 3.7a Permission chips and tabs

- **Permission mode chips** (`PermissionModeChips` in `settings/panels/PermissionMatrix.tsx`):
  one row per permission — label, muted description, a *Locked* pill where it applies — and a
  `role="radiogroup"` (named by the label, described by the description) of 28 px chip buttons
  **Allow** / **Needs approval** (only the approvable own-booking keys) / **Deny**. One chip is
  selected: Allow fills with `--accent-blue`, Needs approval with an `--accent-orange` tint, Deny
  with a `--text-muted` tint (`color-mix`). Roving `tabindex` with the arrow keys (wrapping);
  locked rows and a read-only matrix disable the chips. Deny removes the key from the matrix.
  Use the chips for any three-way choice per row; a two-way flag is a `ToggleSwitch`.
- **Tabs** (Settings → Roles: *Roles* / *Approvals*; My Work: *My Approvals* / *My Assignments* /
  *My Requests*): a `role="tablist"` with an `aria-label`, raw `<button role="tab">`s with
  `aria-selected` and `aria-controls`, and one `role="tabpanel"` `aria-labelledby` the active tab.
  My Work's tabs are the reference: roving `tabindex` with Arrow keys, Home and End, the active
  tab tinted `--accent-blue-alpha` with `--accent-blue` text, a count pill per tab that goes into
  the tab's accessible name (`aria-label="My Approvals, 1 item"`) while the visible number is
  `aria-hidden`. Known drift: the Settings → Roles tabs are a segmented control (active tab on
  `--bg-primary` with `--shadow-sm`) without arrow-key movement. Leaving a tab with unsaved input
  asks first (`confirmAction`). Tabs are for sibling lists of one panel or view — not for
  navigation between views (sidebar) or Settings sections (hub list).

### 3.8 Status representation

| Thing | How it reads |
| --- | --- |
| Kanban card status | Column top border and dot in the `--status-*` token; label from `STATUS_LABELS`. Status and completion are two views of one value (`statusFromCompletion` / `completionForStatus`), never set independently. |
| Due dates | Chip on the card: overdue = `--status-blocked`, due within 7 days (`DUE_SOON_DAYS`) = `--status-in-progress`. |
| Phase / subphase completion | The `--progress-line-color` line on the bar; the `CompletionSlider` edits it. |
| Absence | The absence type's colour (`absence_types.color`, picked from the swatches) on the Staff heatmap and in *My absences*; an absence that doesn't reduce capacity (Home Office) is shown but the person stays plannable. |
| Site closure / holiday / weekend | Timeline cell backgrounds: `--bg-weekend`, the event's colour via `--event-color` (set inline per cell), closures mark the person unavailable. |
| Equipment today | `blocked` > `booked` > available (`useEquipmentTodayStatus`); double bookings show `OverlapWarningIcon` (a red `role="img"` triangle). |
| Pending booking | `PendingBadge` (`components/common/PendingBadge`): a dashed pill — *Pending approval*, *Change pending* or *Removal requested* — on a `--status-warning` tint (`--status-error` for a removal), its `title` naming the approvers (`useApproverSummary`). A pending create's Gantt row is dashed with a muted italic name, its bar hatched (`::after` + `color-mix`, so the inline phase colour survives) and non-interactive; a requested change reads `40% → 60%`. Kanban avatars of pending assignees get a dashed ring and reduced opacity. Pending bookings never count in capacity. |
| Approval decision | `ApprovalActions` (`components/common/ApprovalActions`): inline **Approve** (secondary) / **Reject** (ghost) `sm` buttons under one `useSubmitGuard`; Reject opens `RejectRequestDialog` (shared `Modal`, `Input` *Reason (optional)*, Enter submits, error `Notice`). A `409` (already decided or expired) still calls `onDecided` so the caller reloads. Disabled during What-If. Used by My Work and the Kanban card; the Gantt context menu offers the same two actions as menu items. |
| Live changes | `ActivityFeed` toasts (6 s, at most 4, merged within 2.5 s) and the `recentChanges` list; `SyncStatus` shows an **Offline** badge when the socket is down. |

### 3.9 Gantt timeline

- Rows: `--row-height` for projects, `--detail-row-height` for phases, subphases and
  assignments, `--section-row-height` + 1 px for Group-by section headers. `rowPositions.ts`
  owns the arithmetic; section rows must not contain `row` in their class name and carry no
  `data-project-id` / `data-phase-id`, because the drag, resize and dependency layers find rows
  by those.
- Bars take the item's saved colour (§2.6); milestones are diamonds; the critical path
  highlights bars with `totalFloat <= 0`.
- The tree panel and the timeline body are two vertical scroll containers kept together by
  `useScrollSync` (also the Staff, Equipment, Cross-site and Archived views): wheel and
  trackpad move both panes in the same frame, `scroll` events (scrollbar drag, keyboard) mirror
  without echo, and the hook pads the pane with the shorter scroll range so both reach the same
  end. Never give one pane a fixed bottom padding to "match the scrollbar" — the scrollbar's
  height is 0 with overlay scrollbars, and the padding then misaligns the last rows.
- A bar is draggable or resizable only when it has handlers; those bars get the `interactive`
  class, which sets `touch-action: none` and disables text selection. Read-only bars keep
  scrolling.
- Touch: a touch is converted once, at the bar, with `toMouseLikeEvent` (`utils/touchEvents.ts`);
  a drag or resize starts only after `armTouchGesture` sees more than 5 px of movement, so a tap
  does nothing; document `touchmove` listeners are registered `NON_PASSIVE`. Don't call
  `preventDefault` in `onTouchStart` (React registers it passive).
- Phantom overlays (`PhantomBar`, `PhantomIndicator`, `PhantomArrow`) and `DragIndicator` draw
  the in-progress gesture; `ResourceDropOverlay` is the only place a resource drop creates an
  assignment.
- Timeline cells and headers are generated by `gantt/utils/timeline.ts`; week numbers are ISO
  8601; the current month is highlighted; weekends can be hidden (then week separators appear).
- **Card badge** (`ProjectPanel/CardBadgeView.tsx`, helpers in `cardBadge.ts`): the phase /
  subphase name on a booking row and on the per-person overview row is one rectangle — the
  `cardBadge` class (16 px high, 9 px uppercase semibold, 0.5 px letter-spacing, 3 px radius)
  tinted by `cardBadgeStyle` — whatever it holds. Inside, two buttons that inherit its type:
  the **pin** (booking rows only; `PinIcon` linked / `PinOffIcon` own dates, 12 px,
  `aria-pressed` = own dates; disabled and muted, never removed, where the user may not change
  the booking or it is pending) and the **name** (scrolls the timeline to the booking, the
  overview row to the person's first booking). Both stop the click; the row keeps its context
  menu. Never restyle the badge per row.

### 3.10 Kanban board

- Columns are the four statuses in `CARD_STATUSES` order; each has the 2 px top border and dot
  of its token and a `-soft` header tint. Swimlanes come from `groupCards()` for the chosen
  grouping (none / project / phase / assignee / list-type custom column).
- A card shows its phase colour as a 3 px left border, the breadcrumb path, assignees, the due
  chip and a comment count; it is `role="button"`, focusable, and opens on Enter or Space.
- Drag is `KanbanDragContext` (HTML5 drag events, like `ReorderContext` and
  `useResourceDragDrop`; no library). The move is optimistic; a failure goes through
  `recoverFromPersistFailure` and then tells the user.
- The filter toolbar (`KanbanToolbar`) is a single compact row — project picker, project filter,
  grouping, the **My Todo** toggle with `aria-pressed`, card count — and is a documented
  exception to `PanelToolbar`: it holds filters, not actions.

### 3.11 Header density

`useHeaderDensity()` is the one definition of the header's width tiers (`full` ≥ 1600 px,
`compact` ≥ 1280, `condensed` ≥ 1024, `minimal` below). The header applies it as
`data-density` and every header rule selects on that attribute. The same tier decides which
controls move into `HeaderOverflowMenu`: zoom and undo/redo at `condensed` (they have keyboard
equivalents), plus view modes, theme and What-If at `minimal`. It also decides how many
`OnlineUsers` avatars render and whether the date reads "August 2026" or "Aug 2026".

Header CSS contains no pixel breakpoints above the global mobile one: the only `@media` widths
allowed in `Header.module.css` / `WhatIfToggle.module.css` are the ≤ 640 px mobile rules.

### 3.12 Loading, empty, error and confirmation

- **Loading**: no skeletons. `LoadingScreen` covers app boot; a panel shows muted
  `Loading X...` text in the list's slot. A busy button shows the `loading` spinner (§3.2).
- **Empty**: centred `--text-muted` text that distinguishes *nothing yet* (`No tags yet. Add one
  below.`) from *nothing matches* (`No cards match the current filter.`).
- **Errors**: `<Notice tone="error">` in the dialog or panel (§3.2), next to what it is about;
  an action without a form reports through `uiStore.showFlash()` (`layout/FlashNotice`: the
  `Notice` sits on an opaque `--bg-secondary` slot, because its tint is translucent and would
  let the Staff heatmap or the bars show through). There is no `alert()` left in
  the app — don't add one. What-If "blocked" notices use the dialogs' `.error` box with
  `role="status"` (debt: those dialog boxes still predate `Notice`; move them when you touch a
  dialog). A failed initial load shows `LoadErrorScreen` with **Retry**.
- **Confirmation**: destructive and irreversible actions confirm through
  `await confirmAction({ message, title?, destructive?, confirmLabel?, cancelLabel? })`
  (`utils/confirmDialog.ts`, 44 call sites), worded `Delete X "Name"? … This cannot be undone.`
  Paragraphs split on a blank line. The one host, `ConfirmDialog` (`components/common`), is
  mounted in `App.tsx` and renders the head of `confirmStore`'s queue on a `size="sm"` `Modal`
  titled *Please confirm* unless a `title` is given, with a `secondary` **Cancel** (focused on
  open) and a `primary` **Confirm**, or a `danger` **Delete** when `destructive`. Cancel, the
  header close and Escape resolve `false`; `resetAllStores()` (logout, 401) resolves every
  pending request `false`. A handler that confirms is `async`, awaits the answer and confirms
  *before* taking its submit guard. `window.confirm` is gone — don't add one; tests stub the
  service with `stubConfirm(result)` (`src/test/confirmDialog.ts`) and assert
  `expect.objectContaining({ message })`.
- **Disabled with a reason**: creation actions are disabled while What-If is active. The wording
  comes from `whatIfUnavailableMessage(action)` through `useWhatIfBlocked()`; the reason goes in
  the control's `title` and, where there is room, in a `role="status"` box. Wrap a disabled button
  in `<span title>` when it needs a tooltip (disabled buttons show none). Role-gated actions are
  *hidden* (`canManage && …`), not disabled.

### 3.13 Presence, notifications and activity

- `OnlineUsers`, `ActivityFeed` and the Kanban card assignees colour a person with
  `avatarColorFor(id)` (`utils/avatarColor.ts`, one eight-colour palette keyed by id); the header
  tier caps how many avatars render.
- `NotificationBell` is a popover with an unread count, relative times (`5m ago`,
  `utils/relativeTime.ts`, shared with My Work) and the derived due reminders merged in; it
  dismisses through `useDismissableOverlay` (§3.6). Approval notifications open My Work
  on the matching tab (and filter) instead of a card.
- The sidebar's **My Work** entry carries a count badge (`workStore.openCount`, the approvals to
  decide, capped at `99+`); the count is part of the button's accessible name ("My Work, 1
  approval to decide") and the badge is `aria-hidden`.
- `ActivityFeed` is a polite live region (`role="status" aria-live="polite"`) of bottom-right
  toasts.

### 3.14 Icons

Every icon is a **Material icon** from `@mui/icons-material`, drawn through
`components/common/Icon`: `icons.ts` binds each app name to its Material component, and
`Icon` renders one at a size in px in the current text colour.

```tsx
import { Icon, EditIcon, PlusIcon } from '@/components/common/Icon';

<Icon icon={EditIcon} size={15} />                    // a row action
<Button icon={<Icon icon={PlusIcon} />}>Add type</Button>  // the button sizes it
```

- **Outlined by default** (`EditOutlined`, `DeleteOutlined`, …). A filled glyph only where
  Material has a single variant (`Add`, `Close`, `Check`, the chevrons, `Refresh`) or the
  meaning needs it (`PushPin` = pinned vs `PushPinOutlined` = own dates).
- **Decorative.** `Icon` is `aria-hidden` unless it gets a `title` (then `role="img"` with that
  name), so a button's accessible name is its label alone and tests select buttons by role
  and exact name. A test that needs to tell icons apart reads the Material `data-testid`
  (`CheckCircleOutlinedIcon`).
- **Sized by `size`** (px, default 16), which is the svg's font size — Material icons are 1em
  square. A stylesheet that sets the svg's `width` / `height` (the `Button` icon slot, a row's
  `.chevron`) wins, and rotations by CSS keep working on the svg element.
- **Colour** is `currentColor`: colour the parent, or give the `Icon` a `className`.
- **No inline `<svg>`.** `components/__tests__/noInlineIcons.test.ts` fails on any `<svg>`
  outside `noInlineIconsAllowlist.json` (the Gantt dependency arrows and the Microsoft logo on
  the SSO button, each with its reason). No MUI component other than the icons, no theme
  provider, no `sx` — the one Emotion setting is `IconStyles` in `main.tsx`, which puts the icons'
  base rules first so CSS Modules win a tie.

**Adding an icon.** Pick the Material icon (outlined variant first), add one line to
`icons.ts` — `export { default as FooIcon } from '@mui/icons-material/FooOutlined';`, deep path
so the build keeps only the icons in use — with a short comment saying what it stands for, then
render it with `Icon`. Reuse an existing name when the meaning is the same.

| Meaning | Icon | Size |
| --- | --- | --- |
| Add / create | `PlusIcon` (`Add`) | 14 px |
| Edit | `EditIcon` (`EditOutlined`) | 15 px in Settings rows, 14 px in menus |
| Delete | `TrashIcon` (`DeleteOutlined`) | 15 px in Settings rows, 14 px in menus |
| Remove a link (e.g. *Remove from my sites*) | `UnlinkIcon` (`LinkOffOutlined`) | 15 px |
| Open a related management section (**Manage Skills**, **Manage Types**), Settings | `GearIcon` (`SettingsOutlined`) | 14 px |
| Import a file | `UploadIcon` (`UploadOutlined`) | 14 px; 24–48 px in drop zones |
| Export / download | `DownloadIcon` (`DownloadOutlined`) | 14 px |
| Refresh from a source | `RefreshIcon` | 14 px |
| Back, previous | `BackIcon` (`ChevronLeft`) | 14 px; 16 px in the header |
| Expand (rotated by CSS) / dropdown | `ChevronRightIcon` / `ChevronDownIcon` (`ExpandMore`) | 12 px |
| Log out | `LogoutIcon` | 14 px; 16 px in the account menu |
| Drag a list row / a Gantt or resource row | `DragHandleIcon` / `DragDotsIcon` (`DragIndicator`) | 16 px / 12 px |
| Close, dismiss, cancel | `CloseIcon` | 18 px in `Modal`, 20 px in admin dialogs, 12–14 px inline |
| A checked option | `CheckIcon` | 12 px in a 16 px checkbox |
| Warning, conflict | `WarningIcon` (`WarningAmberOutlined`) | 14–16 px |
| Settings sections, sidebar views | one icon each (`sections.tsx`, `Navigation.tsx`) | 16 px / 18 px |

Row actions in the Settings panels are 28 px buttons rendering these icons (`CheckIcon`,
`CloseIcon` for an inline confirm/cancel pair, `CheckCircleIcon` / `CircleIcon` for an
activate toggle), each with an `aria-label` naming the row (`Edit Bob Brown`, `Delete HPLC`)
next to its `title`.

**Documented exception — the Gantt header.** The project panel's header actions (staff and
equipment toggle, project filter, group by, colour by, column visibility, custom-column manager,
import, new project) are compact 28 px buttons, mostly icon-only, because the header sits above
a dense timeline where 36 px labelled buttons would take too much room. Keep them compact, give
each a `title` *and* an `aria-label`, mark svgs `aria-hidden`, give on/off toggles
`aria-pressed` and dropdown triggers `aria-expanded` + `aria-haspopup` (debt: `.newProjectBtn`
has no fixed height).

---

## 4. Dates and numbers

- Model dates are `YYYY-MM-DD` strings. Parse them with `parseLocalDate` and format with
  `formatLocalDate` / `toDateOnly` / `addDaysToDateString` from `utils/date.ts`. **Never**
  `new Date(str)`, `parseISO(str)` or `toISOString().split('T')[0]` on a model date — both are
  UTC and shift the day west of UTC. `new Date(str)` is fine for real timestamps
  (`created_at`).
- Display dates in the browser locale with a short month: `formatSingleDate` (`15 Jan` or
  `Jan 15`, by locale) and `formatShortDateRange` (`15 Jan - 28 Feb`), both from `utils/date.ts`.
  Timeline headers use `formatWeekNumber` (ISO week), `formatMonthYear` and `formatQuarter`.
  Notifications use relative times (`5m ago`). Debt: about 15 ad-hoc `toLocaleDateString` calls
  and two full numeric formats (`SiteForm`, `KanbanCardModal`).
- A date field shows `formatMediumDate` (`22 Oct 2026` or `Oct 22, 2026`, by locale; `''` for no
  date), the `YYYY-MM-DD` wrapper over `formatDateDisplay`.
- Allocations are whole percentages from 1 to 100 (the slider steps by 5); capacity is a
  percentage too. Counts in toolbars read `12 users`, `3 of 8 cards`.

---

## 5. Wording

- UI strings are English literals; there is no i18n layer.
- Sentence case everywhere except proper names: *Add holiday*, *Manage Skills* is the one legacy
  Title Case family (the Settings panels' Manage buttons) — don't add more.
- Button labels are imperative and name the object: **Add holiday**, **Save Changes**,
  **Import .ics**. A busy button keeps its label and shows the spinner (`loading`, §3.2) — no
  *Saving...* labels.
- Confirmations: `Delete X "Name"?` followed by what else is removed and `This cannot be undone.`
- A deleted author reads **Deleted user**; a blocked action's reason is the
  `whatIfUnavailableMessage()` text; the empty-state wording is in §3.12.

---

## 6. Accessibility

- Every icon-only control has an `aria-label` that names its target (`Delete ISO Audit`), and
  its `Icon` is `aria-hidden` (§3.14).
- Toggles are `role="switch"` (`ToggleSwitch`) or carry `aria-pressed` (view modes, **My Todo**,
  *My absences* filters).
- Dropdown triggers carry `aria-expanded` and `aria-haspopup="dialog"`; a checkbox/radio panel
  is a non-modal `role="dialog"` with an `aria-label`.
- Focus is always visible: the global `:focus-visible` ring, 2 px `--accent-blue`, offset 2 px.
- Escape closes the innermost layer only (§3.5, §3.6) — `Modal`'s document listener acts only
  for the top of the open-modal stack, so a confirm over the Settings hub closes alone. Global
  shortcuts (`Esc`, `Home`, `+`/`-`, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) are ignored while any
  dialog is open (`activeModal` set or a `Modal` mounted, `openModalCount`) or focus is in an
  input, textarea or contentEditable. The user-facing list is
  `docs/user-guide/keyboard-shortcuts.md`.
- Kanban cards are `role="button"`, focusable, Enter/Space activate; the activity feed is a
  polite live region; error boxes are `role="alert"`.
- `Modal` traps Tab inside the innermost dialog and returns focus to the opener on close (§3.5);
  a busy `Button` reports `aria-busy`; `Input` / `Select` errors are `aria-invalid` + `role="alert"`.

---

## 7. Mobile and touch

- `@media (max-width: 640px)` (so 640 px inclusive) shrinks the layout tokens (§2.9), sets
  `body` to 13 px, and raises `button`, `[role="button"]`, `input` and `select` to **44 × 44 px**
  (`min-height` and `min-width`). Exclusions are by class-name substring, **case-sensitive**:
  `Badge`, `badge`, `Level`, `level`, `expandBtn`, `collapseBtn`, `dragHandle`, `levelBtn`,
  `wbsLevel` for buttons; `Badge`/`badge`/`Level`/`level` for `[role="button"]`; `Cell`/`cell`
  for inputs. Name a deliberately compact inline control accordingly, or expect it to grow.
  A round control must grow in **both** dimensions or it becomes an oval: raise its width with
  its height (as `ColorSwatchPicker` does), or exclude it by class name.
- **Checkboxes, radios and ranges never grow.** A control keeps the one size it has on every
  device (a checkbox is 16 px, `global.css`), so a form looks the same on a phone as on a desktop;
  the 44 px touch area comes from the `<label>` row around it (`label:has(> input[type=…])`
  gets the `min-height`), which toggles the box anyway. Put a checkbox inside its label, not
  next to it, or the phone gets no touch target for it.
  `src/styles/__tests__/mobileTouchTargets.test.ts` pins the exclusion.
- **Listbox rows are touch targets too**: at ≤ 640 px every `[role="option"]` row gets a 44 px
  `min-height` (rows are full width, so only the height grows) — the `SearchableSelect` and
  `MultiSelectDropdown` rows, the tag and `@` suggestions and the job-title autocomplete alike.
  Pinned by the same test.
- `@media (hover: none) and (pointer: coarse)` (touch devices at any width) raises buttons to a
  40 px `min-height`, keeps the completion/type badges and `wbsLevel` chips at their own size,
  shows drag handles at 60 % opacity, disables hover transitions and enables touch scrolling on
  the timelines.
- Gesture rules for the timeline bars are in §3.9.

---

## 8. Do's and don'ts

| Do | Don't |
| --- | --- |
| `var(--accent-red)`, `color-mix(in srgb, var(--accent-red) 25%, transparent)` for a tint, `var(--shadow-md)` for a shadow | `#ef4444`, `rgba(239, 68, 68, …)` — the per-file counts in `src/styles/__tests__/rawColorAllowlist.json` (357 literals in 71 module files at 1.7.0) are a ratchet: the guard test fails when a file's count rises; lower a file's number when you pay its debt |
| `--border-color`, `--accent-blue`, `--radius-md`, `--font-size-sm` (the tokens in use) | The alias tokens `--border-default`, `--accent-primary`, or a new spacing token for one file |
| A `var(--x)` only when `--x` is defined in `styles/` or set by the component itself | A fallback inside `var()` — on an undefined token it hides the typo, on a defined one it is dead weight; the guard test rejects both |
| `<Button>` for actions, `md` in toolbars and footers, `loading` while a write runs | A raw `<button>` with local styles for an action; `sm` in a toolbar; a `'Saving...'` label swap |
| `<Input label>` / `<Select label options>` for every text-like field and dropdown | A raw `<input>` / `<select>` with a local `.input` class — the raw-control ratchet (`rawFormControls.test.ts`) fails when a file's count rises |
| `Modal` with explicit Close / Cancel and Escape | Backdrop-click close, in any dialog |
| `await confirmAction({ message, destructive: true })` before a delete | `window.confirm(...)` — none left, and a native dialog blocks the tab and ignores the theme |
| `ToggleSwitch` for any on/off flag, in a dialog too | A bare checkbox for a flag — checkboxes only pick items from a list |
| `data-density` selectors in header CSS | Pixel breakpoints in header CSS above 640 px |
| Select a raw store slice and `useMemo`, or `useShallow` | A store selector that returns a new array or object (Zustand 5 re-renders forever) |
| `parseLocalDate` / `formatLocalDate` | `new Date('2026-01-05')` |
| `<Notice tone="error">` in place, `uiStore.showFlash()` for a detached action | `alert()` — there are none left |
| `aria-label` naming the row on an icon button | A `title` alone |
| Classes joined with `[…].filter(Boolean).join(' ')` or a template string | A class-name library (`clsx` was removed as unused) |
| camelCase class names in a co-located `X.module.css` | Global utility classes (`.flex`, `.gap-*`, `.sr-only` in `global.css` are unused) or snake_case classes keyed off API values (`NotificationBell` debt) |
| `window.setTimeout` with a `number` ref | A bare `setTimeout` typed as `NodeJS.Timeout` |

---

## 9. Adding a token or a theme

1. Add the token to `:root` in `variables.css` **and** to `[data-theme="light"]`, and to both
   S-Theme blocks in `themes.css` (the S-Theme only inherits what it doesn't override, so a
   colour that depends on the background needs an explicit value in every block).
2. Name it semantically (`--accent-teal`, `--status-done`), with a hex in a comment if the
   value is not an obvious Tailwind stop.
3. Reference it with `var(--name)` — no fallback. Run the guard test
   (`npx vitest run src/styles`).
4. Read it in JavaScript only through `utils/themeColors.ts`.
5. Add a row to §2 of this document.

A new theme is a new `[data-theme="…"]` block overriding every token the light theme overrides,
plus an entry in `THEMES` and, if it is a new family, `THEME_FAMILIES` in `utils/storage.ts`.

---

## 10. Related files

| File | What it holds |
| --- | --- |
| `frontend/src/styles/variables.css` | Default dark and light tokens, layout dimensions, typography, z-index scale |
| `frontend/src/styles/themes/themes.css` | S-Theme dark and light |
| `frontend/src/styles/global.css` | Resets, native controls, focus ring, What-If frame, scrollbar, print, mobile and touch rules |
| `frontend/src/styles/__tests__/cssTokens.test.ts` | Guard: every `var(--x)` read is defined |
| `frontend/src/components/common/` | `Icon` (the icon set, §3.14), `Button`, `Input`, `Select`, `ToggleSwitch`, `Modal`, `ContextMenu`, `AllocationSlider`, `MentionTextarea`, `ProjectFilterDropdown`, `NotificationBell`, `OnlineUsers`, `ActivityFeed`, `ICSImportPanel`, `OverlapWarningIcon`, `RoleChecklist`, `PendingBadge`, `ApprovalActions`, `CardComments`, `useSubmitGuard` |
| `frontend/src/components/settings/PanelToolbar.tsx` | Toolbar layout |
| `frontend/src/components/common/Modal/Modal.test.tsx`, `components/admin/modals/CredentialsModal.test.tsx`, `components/common/Button/Button.test.tsx` | Executable guards of the modal and button rules |
| `frontend/src/utils/themeColors.ts`, `utils/colorSwatches.ts`, `utils/tags.ts` | Theme reads in JS, user-pickable colours, `barTextColor` |
| `frontend/src/hooks/useHeaderDensity.ts`, `utils/touchEvents.ts`, `hooks/useKeyboardShortcuts.ts` | Header tiers, touch mapping, global shortcuts |
| `docs/user-guide/keyboard-shortcuts.md` | The user-facing shortcut list |
