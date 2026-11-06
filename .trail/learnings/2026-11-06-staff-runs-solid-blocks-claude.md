---
title: "Staff overview runs are solid blocks of at most 10 days; the week band always lives in the grid layer"
author: Claude
date: 2026-11-06
branch: feat/weekends-and-polish
id: l-b285d5f3
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/views/StaffView/StaffTimelineBody.tsx
  - frontend/src/components/views/StaffView/StaffTimelineBody.module.css
  - frontend/src/hooks/useWorkloadCalculation.ts
---

## Decided
- Vincent rejected the translucent per-cell fill ("pale overlay"). A run of equal days is now **solid blocks** in the badge palette, 14 px tall, with the label in `--text-on-accent`. `chunkRuns` cuts a run into pieces of at most `MAX_RUN_CELLS = 10` cells so a label is always on screen. Home Office days do not split a run, closure days included: each one gets an underline inside the block. Conflict days booking different amounts do not split it either. They all read "0%", and the tooltip shows the range ("50–170%"). In the first re-shoot, Diana's closure week was seven single "0%" blocks.
- **One rule for the week band**: it lives in each timeline's grid layer, under every bar, block and label. That covers the Staff body too, whose bands are in its `.grid`.

## Ruled out
- A `.weekBands` overlay above the heatmap (the first fix wave). It painted across the badges ("10|0%"). Giving the badge a z-index cannot fix that while the block has its own z-index, because the block is then a stacking context. Vincent also wanted the band to sit "always under", never sometimes over.
