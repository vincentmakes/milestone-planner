---
title: "Dashboard charts: ECharts 6 labels a sankey node with an id by that id, counts the treemap's virtual root as level 0, and warns on grid.containLabel"
author: Claude
date: 2026-10-24
branch: feat/dashboards
cost: { minutes: 0, tokens: 0 }
touches:
  - frontend/src/components/views/DashboardsView/charts/toOption.ts
  - frontend/src/components/views/DashboardsView/charts/__tests__/realECharts.test.ts
---

## Decided
- **Sankey nodes carry `id: '1:' + keyId(key)` / `'2:' + …`** (so a value on both sides stays two nodes), and ECharts then uses the id as the node's name: its default label and `params.name` in the tooltip read `1:11`. `toOption` gives the sankey a `label.formatter` and a tooltip that look the name up from `params.data.id`.
- **Treemap `levels[0]` is ECharts' virtual root** (`TreemapSeries.getInitialData` wraps `data` in a root; `levelModels[node.depth]`, root depth 0). A node's `gapWidth` parts *its children*. So the levels are root `{gapWidth: 2}` (between the first dimension's boxes), first dimension `{gapWidth: 1, borderWidth: 2, upperLabel}` (its name above its children), second dimension `{borderColor}`. With two levels written as "parents, children" the parent names never show and the root reserves a blank 22 px upper label.
- **No `grid.containLabel`**: in ECharts 6 it needs `use(LegacyGridContainLabel)` and otherwise logs a dev warning; `{outerBoundsMode: 'same', outerBoundsContain: 'axisLabel'}` is the documented equivalent.
- **Tooltip `formatter` strings are HTML**: labels are people's data, so `escapeHtml` them (the bar/line/pie `valueFormatter` path is escaped by ECharts itself).
- **`realECharts.test.ts`** renders the four new kinds through the real ECharts (SSR SVG, dev build, `setPlatformAPI({measureText})` because jsdom has no canvas) and asserts no ECharts warning plus the drawn texts. It caught both traps above, which the option-shape unit tests could not.

## Notes
- A heatmap's period axis is sorted by key: the server orders rows by (first dimension, second), so with team × month the months of a later team come after the first team's — row order alone is not chronological.
