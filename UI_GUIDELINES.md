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
   `Input`, `Select`, `AllocationSlider`, `TagFilterDropdown`, `ContextMenu`), use it.

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
as `data-density` (§3.11). Debt: off-scale `@media` widths remain in a few stylesheets (768 px ×6,
600 px ×4, 500 px ×1) — don't add more.

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
import { PlusIcon } from '@/components/settings/panels/PanelIcons';

<Button icon={<PlusIcon />} onClick={handleCreate}>
  Add holiday
</Button>
```

**Variants**

| Variant | Looks like | Use it for |
| --- | --- | --- |
| `primary` (default) | Solid blue | The main action of a panel or dialog: **Add X**, **Create X**, **Save Changes**. At most one per toolbar or footer. |
| `secondary` | Bordered, neutral | Every other action next to the primary one: **Manage Skills**, **Import .ics**, **Export .ics**, **Refresh**, **Cancel**, **Close**. |
| `ghost` | Text only, background on hover | Back links (**Back to list**, **All sites**), low-emphasis actions inside rows, the admin-portal **Logout**. |
| `danger` | Solid red | The **Delete** action in an edit dialog's footer, placed far left (PhaseModal, SubphaseModal, AssignmentModal, EquipmentBlockModal, CustomColumnModal, UsersPanel). The confirmation itself is `window.confirm` (§3.12). |
| `icon` | Square, transparent | An icon-only button with an `aria-label`. Available but **unused today**: the existing icon-only buttons are raw (§3.3). |

**Sizes**

| Size | Height | Padding / font | Use it for |
| --- | --- | --- | --- |
| `md` (default) | 36 px | `0 1rem`, `--font-size-sm` | Everything: toolbars, add rows, back links, dialog footers. The Settings add-row inputs are 36 px too, so they line up. |
| `sm` | 28 px | `0 0.75rem`, `--font-size-xs` | Only for actions repeated on every row of a dense list (**Edit** / **Delete** in *My absences*). |
| `lg` | 44 px | `0 1.5rem`, `--font-size-base` | Large standalone calls to action. **Unused today**: both login screens still use raw buttons (debt). |

Don't use `sm` in a toolbar. A small primary button next to medium ones was the drift this
guide was written to stop.

**Icons.** Pass icons through the `icon` prop (`iconPosition="right"` puts it after the label).
The button sizes the svg — 14 px in `md`, 12 px in `sm` — and the icon inherits the text colour
through `currentColor`. Don't put an inline `<svg>` with a hand-tuned margin in the children.

**States.** `disabled` dims to 50 % opacity (the global `button:disabled` rule). `loading` shows
a spinner over the label and disables the button; no caller uses it yet — dialogs swap the label
instead (`isSubmitting ? 'Saving...' : 'Save Changes'`), and that is the convention until
`loading` is adopted. Inside a `<form>`, set `type="button"` on every button that must not
submit (back links, Cancel) and `type="submit"` on the one that does, as the Tags and Absence
types add rows do; Enter in the input then submits.

Writes from a dialog are guarded with `useSubmitGuard` (`components/common/useSubmitGuard.ts`,
24 files) so Enter-twice or a double click cannot create duplicates. Debt: `KanbanCardModal`
(a `useState` busy flag), `ImportProjectModal`, the delete in `MyAbsencesModal`, `GeneralPanel`,
`SSOPanel` and `PredefinedPhasesPanel` are not guarded.

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
**Back to holidays**, **All sites**). Don't use a text arrow or a styled link (debt:
`AdminLoginScreen` still has a `← Back to Application` anchor).

**Row actions.** Edit, delete and similar actions repeated on every row are compact **28 px**
icon-only buttons (`.iconBtn` / `.actionBtn` / `.editBtn` in the panel's module) with
`PanelIcons` at their default size, each with an `aria-label` that names the row (`Delete ISO
Audit`) and usually a `title`. They stay compact so a long list remains scannable. Debt: the
Equipment, Users, Equipment types and Skills panels use 32 px, Sites has no fixed size, several
rows carry a `title` but no `aria-label`, two icon-only confirm/cancel pairs (`UsersPanel`,
`EquipmentPanel` inline edits) have no accessible name, and *My absences* uses text `ghost sm`
buttons. None of these class names is on the mobile exclusion list, so on phones they grow to
44 px (§7).

### 3.4 Forms

- **`Input`** (`components/common/Input`): `label`, `error`, `hint`, `leftIcon`, `rightIcon`,
  `fullWidth`, plus every native input prop. 36 px tall; the label is linked through `htmlFor`
  (an id is generated when none is given); an `error` replaces the `hint`.
- **`Select`** (`components/common/Select`): `options: {value, label, disabled?}[]`,
  `placeholder` (rendered as a disabled empty option), `icon`, `label`, `error`, `hint`,
  `fullWidth`. 36 px.
- **`ToggleSwitch`** (`components/common/ToggleSwitch`): every on/off *setting* or preference. A
  visually hidden checkbox with `role="switch"`, so keyboard, screen-reader and label behaviour
  come for free; pass `label` for visible text or `aria-label` when there is none. Used by
  General, Tags, SSO and Absence types. Debt: bare checkboxes remain for the Active flags in
  `SiteForm`, `UsersPanel` and `EquipmentPanel`, SSO auto-create, the site-closure flag, and the
  entity flags in dialogs (Confirmed, Archived, Milestone).
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
- Adoption of `Input` / `Select` is still low (about 126 raw `<input>` and 30 raw `<select>`,
  styled through local `.input` classes). New forms use the shared components; migrate old ones
  when you touch them.

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
- A parent that opens a child dialog passes `closeOnEscape={!childOpen}` so Escape closes only
  the innermost layer. A picker *inside* a modal (`TagPicker`, the `MentionTextarea` suggestion
  list) handles Escape in its React `onKeyDown` and calls `stopPropagation()` for the same
  reason.
- `modalContext.returnTo` reopens the previous dialog when a chained one closes (My absences →
  absence dialog). Unsaved changes are guarded with `onDirtyChange` + `window.confirm`
  (`SettingsHub`).
- The container receives focus on open (`tabIndex={-1}`). Known gaps: no focus trap, focus is
  not restored on close, and the title id is a fixed `modal-title` (duplicated when dialogs
  nest).
- Standalone dialogs that can't use `Modal` — the admin-portal modals in
  `components/admin/modals/` — must not attach a close handler to their overlay and use the
  `useEscapeKey` hook (`src/hooks/useEscapeKey.ts`) for Escape. Debt: they lack `role="dialog"`
  and a labelled close button.

### 3.6 Dropdowns, popovers and context menus

A new non-modal overlay (dropdown, filter panel, popover, context menu) closes:

- on a `mousedown` outside the trigger and panel,
- when focus leaves the wrapper (Tab out), and
- on Escape — listened for in the capture phase with propagation stopped, so the key closes only
  this panel and never reaches the app-wide shortcuts — after which focus returns to the trigger.

`TagFilterDropdown` and `TagGroupChoiceDropdown` are the reference implementations. A panel with
checkboxes or radios is a non-modal `role="dialog"` (not a `menu`) with an `aria-label`; its
trigger carries `aria-expanded` and `aria-haspopup="dialog"`.

`ContextMenu` (`components/common/ContextMenu`) is the right-click menu: items take `danger`,
`divider`, `disabled` plus a `title` giving the reason, and the menu keeps itself inside the
viewport.

Debt (closing on mousedown only, no focus-out, bubble-phase Escape, or `aria-haspopup="true"`):
`HeaderOverflowMenu`, `ContextMenu`, `Header`, `UserMenu`, `NotificationBell`, the
`ProjectPanel` column-visibility dropdown, `CustomColumnHeader`, the Staff and Equipment view
filters, `DependencyPopup`. Bring them to the rule when you touch them; don't copy them.

### 3.7 Tags and pills

Tags are rounded pills filled with the tag colour. The text colour always comes from
`barTextColor(tag.color)` (`utils/tags.ts`): white or near-black, whichever contrasts more, so
a pill stays readable on light colours. Don't hard-code `color: white` on a coloured background
(debt: `PhaseBar` and `ProjectBar` still do on user-chosen colours; `ProjectBar` uses
`barTextColor` only in colour-by mode).

```tsx
<span className={styles.pill} style={{ backgroundColor: tag.color, color: barTextColor(tag.color) }}>
  {tag.name}
</span>
```

Resolve a tag's colour and group through `appStore.tags` / `tagGroups` by id (`indexTags`), never
from the inline `project.tags[].color`, which is stale during What-If.

### 3.8 Status representation

| Thing | How it reads |
| --- | --- |
| Kanban card status | Column top border and dot in the `--status-*` token; label from `STATUS_LABELS`. Status and completion are two views of one value (`statusFromCompletion` / `completionForStatus`), never set independently. |
| Due dates | Chip on the card: overdue = `--status-blocked`, due within 7 days (`DUE_SOON_DAYS`) = `--status-in-progress`. |
| Phase / subphase completion | The `--progress-line-color` line on the bar; the `CompletionSlider` edits it. |
| Absence | The absence type's colour (`absence_types.color`, picked from the swatches) on the Staff heatmap and in *My absences*; an absence that doesn't reduce capacity (Home Office) is shown but the person stays plannable. |
| Site closure / holiday / weekend | Timeline cell backgrounds: `--bg-weekend`, the event's colour via `--event-color` (set inline per cell), closures mark the person unavailable. |
| Equipment today | `blocked` > `booked` > available (`useEquipmentTodayStatus`); double bookings show `OverlapWarningIcon` (a red `role="img"` triangle). |
| Live changes | `ActivityFeed` toasts (6 s, at most 4, merged within 2.5 s) and the `recentChanges` list; `SyncStatus` shows an **Offline** badge when the socket is down. |

### 3.9 Gantt timeline

- Rows: `--row-height` for projects, `--detail-row-height` for phases, subphases and
  assignments, `--section-row-height` + 1 px for Group-by section headers. `rowPositions.ts`
  owns the arithmetic; section rows must not contain `row` in their class name and carry no
  `data-project-id` / `data-phase-id`, because the drag, resize and dependency layers find rows
  by those.
- Bars take the item's saved colour (§2.6); milestones are diamonds; the critical path
  highlights bars with `totalFloat <= 0`.
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

### 3.10 Kanban board

- Columns are the four statuses in `CARD_STATUSES` order; each has the 2 px top border and dot
  of its token and a `-soft` header tint. Swimlanes come from `groupCards()` for the chosen
  grouping (none / project / phase / assignee / list-type custom column).
- A card shows its phase colour as a 3 px left border, the breadcrumb path, assignees, the due
  chip and a comment count; it is `role="button"`, focusable, and opens on Enter or Space.
- Drag is `KanbanDragContext` (HTML5 drag events, like `ReorderContext` and
  `useResourceDragDrop`; no library). The move is optimistic; a failure goes through
  `recoverFromPersistFailure` and then tells the user.
- The filter toolbar (`KanbanToolbar`) is a single compact row — project picker, tag filter,
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
  `Loading X...` text in the list's slot. A busy button swaps its label (§3.2).
- **Empty**: centred `--text-muted` text that distinguishes *nothing yet* (`No tags yet. Add one
  below.`) from *nothing matches* (`No cards match the current filter.`).
- **Errors**: an inline `.error` box in the dialog or panel — `--accent-red` text on
  `--accent-red-alpha` (older panels: `rgba(239,68,68,.1)`), `0.75rem` padding, `role="alert"`.
  What-If "blocked" notices use the same box with `role="status"`. A failed initial load shows
  `LoadErrorScreen` with **Retry**. Debt: `alert()` remains in 23 places (10 in the admin portal);
  replace with the inline box when you touch them.
- **Confirmation**: destructive actions confirm with `window.confirm` before the call (44 call
  sites), worded `Delete X "Name"? … This cannot be undone.` There is no shared confirm dialog
  yet (the custom one in `StaffView` for deleting an absence is the lone exception); adding one is
  the obvious next step, until then keep the native dialog and the wording.
- **Disabled with a reason**: creation actions are disabled while What-If is active. The wording
  comes from `whatIfUnavailableMessage(action)` through `useWhatIfBlocked()`; the reason goes in
  the control's `title` and, where there is room, in a `role="status"` box. Wrap a disabled button
  in `<span title>` when it needs a tooltip (disabled buttons show none). Role-gated actions are
  *hidden* (`canManage && …`), not disabled.

### 3.13 Presence, notifications and activity

- `OnlineUsers` shows avatars coloured by `id % 8` (debt: the palette is duplicated in
  `ActivityFeed`); the header tier caps how many render.
- `NotificationBell` is a popover with an unread count, relative times (`5m ago`) and the derived
  due reminders merged in; it follows the mousedown-outside close only (§3.6 debt).
- `ActivityFeed` is a polite live region (`role="status" aria-live="polite"`) of bottom-right
  toasts.

### 3.14 Icons

Take icons from `components/settings/panels/PanelIcons.tsx` and add a new one there rather than
inlining an svg. Every icon is `aria-hidden`, so a button's accessible name is its label alone
and tests select buttons by role and exact name.

| Action | Icon | Default size |
| --- | --- | --- |
| Add / create | `PlusIcon` | 14 px |
| Edit | `EditIcon` | 15 px |
| Delete | `TrashIcon` | 15 px |
| Remove a link (e.g. *Remove from my sites*) | `UnlinkIcon` | 15 px |
| Open a related management section (**Manage Skills**, **Manage Types**) | `GearIcon` | 14 px |
| Import a file | `UploadIcon` | 14 px |
| Export / download | `DownloadIcon` | 14 px |
| Refresh from a source | `RefreshIcon` | 14 px |
| Back | `BackIcon` | 14 px |
| Log out | `LogoutIcon` | 14 px |
| Drag handle | `DragHandleIcon` | 16 px |

Debt: inline 16 px svgs remain in the row actions of the Equipment types, Skills, Predefined
phases, Users, Sites and Equipment panels.

**Documented exception — the Gantt header.** The project panel's header actions (staff and
equipment toggle, tag filter, group by, colour by, column visibility, custom-column manager,
import, new project) are compact 28 px buttons, mostly icon-only, because the header sits above
a dense timeline where 36 px labelled buttons would take too much room. Keep them compact, give
each a `title` *and* an accessible name, mark svgs `aria-hidden`, and give on/off toggles
`aria-pressed` (debt: the staff/equipment toggle lacks it, the raw header buttons have `title`
only, and `.newProjectBtn` has no fixed height).

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
  and two full numeric formats (`SiteForm`, `KanbanCardModal`); `formatDateDisplay` is unused.
- Allocations are whole percentages from 1 to 100 (the slider steps by 5); capacity is a
  percentage too. Counts in toolbars read `12 users`, `3 of 8 cards`.

---

## 5. Wording

- UI strings are English literals; there is no i18n layer.
- Sentence case everywhere except proper names: *Add holiday*, *Manage Skills* is the one legacy
  Title Case family (the Settings panels' Manage buttons) — don't add more.
- Button labels are imperative and name the object: **Add holiday**, **Save Changes**,
  **Import .ics**. A busy label is the verb in progress with three dots: *Saving...*.
- Confirmations: `Delete X "Name"?` followed by what else is removed and `This cannot be undone.`
- A deleted author reads **Deleted user**; a blocked action's reason is the
  `whatIfUnavailableMessage()` text; the empty-state wording is in §3.12.

---

## 6. Accessibility

- Every icon-only control has an `aria-label` that names its target (`Delete ISO Audit`), and
  its svg is `aria-hidden`.
- Toggles are `role="switch"` (`ToggleSwitch`) or carry `aria-pressed` (view modes, **My Todo**,
  *My absences* filters).
- Dropdown triggers carry `aria-expanded` and `aria-haspopup="dialog"`; a checkbox/radio panel
  is a non-modal `role="dialog"` with an `aria-label`.
- Focus is always visible: the global `:focus-visible` ring, 2 px `--accent-blue`, offset 2 px.
- Escape closes the innermost layer only (§3.5, §3.6); global shortcuts (`Esc`, `Home`, `+`/`-`,
  Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) are ignored while a registered dialog is open or focus is in an
  input, textarea or contentEditable. The user-facing list is
  `docs/user-guide/keyboard-shortcuts.md`.
- Kanban cards are `role="button"`, focusable, Enter/Space activate; the activity feed is a
  polite live region; error boxes are `role="alert"`.
- Known gaps: no focus trap or focus restore in `Modal`; admin modals without `role="dialog"`;
  the unlabelled row actions listed in §3.3.

---

## 7. Mobile and touch

- `@media (max-width: 640px)` (so 640 px inclusive) shrinks the layout tokens (§2.9), sets
  `body` to 13 px, and raises `button`, `[role="button"]`, `input` and `select` to **44 × 44 px**
  (`min-height` and `min-width`). Exclusions are by class-name substring, **case-sensitive**:
  `Badge`, `badge`, `Level`, `level`, `expandBtn`, `collapseBtn`, `dragHandle`, `levelBtn`,
  `wbsLevel` for buttons; `Badge`/`badge`/`Level`/`level` for `[role="button"]`; `Cell`/`cell`
  for inputs. Name a deliberately compact inline control accordingly, or expect it to grow.
- `@media (hover: none) and (pointer: coarse)` (touch devices at any width) raises buttons to a
  40 px `min-height`, keeps the completion/type badges and `wbsLevel` chips at their own size,
  shows drag handles at 60 % opacity, disables hover transitions and enables touch scrolling on
  the timelines.
- Gesture rules for the timeline bars are in §3.9.

---

## 8. Do's and don'ts

| Do | Don't |
| --- | --- |
| `var(--accent-red)` | `#ef4444`, `rgba(239, 68, 68, …)` — debt: 137 hex literals in 39 module files, 59 red rgba literals; worst files `DependencyPopup` (12), `StaffTimelineBody` (9), `KanbanCard` (8), `EquipmentTimelineBody` (8), `CompletionSlider` (8), `TimelineBody` (7); in TSX `SkillsPanel` (10), `OnlineUsers` (8), `ActivityFeed` (8) |
| `--border-color`, `--accent-blue`, `--radius-md`, `--font-size-sm` (the tokens in use) | The alias tokens `--border-default`, `--accent-primary`, or a new spacing token for one file |
| A `var(--x)` only when `--x` is defined in `styles/` or set by the component itself | A fallback inside `var()` to paper over an undefined token (the guard test rejects both) |
| `<Button>` for actions, `md` in toolbars and footers | A raw `<button>` with local styles for an action; `sm` in a toolbar |
| `Modal` with explicit Close / Cancel and Escape | Backdrop-click close, in any dialog |
| `ToggleSwitch` for a setting | A bare checkbox for a setting |
| `data-density` selectors in header CSS | Pixel breakpoints in header CSS above 640 px |
| Select a raw store slice and `useMemo`, or `useShallow` | A store selector that returns a new array or object (Zustand 5 re-renders forever) |
| `parseLocalDate` / `formatLocalDate` | `new Date('2026-01-05')` |
| The `.error` box with `role="alert"` | `alert()` for a recoverable error |
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
| `frontend/src/components/common/` | `Button`, `Input`, `Select`, `ToggleSwitch`, `Modal`, `ContextMenu`, `AllocationSlider`, `MentionTextarea`, `TagFilterDropdown`, `NotificationBell`, `OnlineUsers`, `ActivityFeed`, `ICSImportPanel`, `OverlapWarningIcon`, `useSubmitGuard` |
| `frontend/src/components/settings/PanelToolbar.tsx`, `panels/PanelIcons.tsx` | Toolbar layout and the icon set |
| `frontend/src/components/common/Modal/Modal.test.tsx`, `components/admin/modals/CredentialsModal.test.tsx`, `components/common/Button/Button.test.tsx` | Executable guards of the modal and button rules |
| `frontend/src/utils/themeColors.ts`, `utils/colorSwatches.ts`, `utils/tags.ts` | Theme reads in JS, user-pickable colours, `barTextColor` |
| `frontend/src/hooks/useHeaderDensity.ts`, `utils/touchEvents.ts`, `hooks/useKeyboardShortcuts.ts` | Header tiers, touch mapping, global shortcuts |
| `docs/user-guide/keyboard-shortcuts.md` | The user-facing shortcut list |
