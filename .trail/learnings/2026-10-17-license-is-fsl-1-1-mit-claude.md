---
title: License is FSL-1.1-MIT; README badges mirror turbo-ea
author: Claude
date: 2026-10-17
branch: chore/fsl-license-readme-badges
cost: { minutes: 20, tokens: 2429 }
touches:
  - LICENSE
  - README.md
  - CLAUDE.md
  - frontend/package.json
  - CHANGELOG.md
---

Since 1.6.1 the project is licensed FSL-1.1-MIT (file is LICENSE, not LICENSE.txt; text copied verbatim from vincentmakes/turbo-ea). Releases up to 1.6.0 stay MIT. The README License section, the license badge, frontend/package.json license and the package-lock.json root entry must all agree with LICENSE. README badges follow turbo-ea's set (CI, coverage, license, Python, React) minus GitHub Sponsors, which the user asked to drop. No GHCR-pulls badge: docker.yml only builds the image, it never publishes to GHCR. Adding the license field to frontend/package.json trips version-check.yml, so the license change shipped as a 1.6.1 release with a CHANGELOG entry. Lockfile root license was added by hand because the sandbox has Node 22, not the required Node 24.
