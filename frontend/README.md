# Milestone Frontend (React)

React/TypeScript SPA for Milestone. For the full architecture reference (stores, Gantt drag pipeline, WebSocket refetch, What-If mode, conventions), see the **Frontend Architecture** section of the repo-root [CLAUDE.md](../CLAUDE.md) — this README is only a quick orientation.

## Tech Stack

- **React 18** + **TypeScript** — UI (no client-side router: views are Zustand state, `App.tsx` branches on the URL path)
- **Vite** — build tool and dev server (port 3333)
- **Zustand** — state management
- **TanStack Query** — client cache (provider-level defaults)
- **date-fns** — date utilities
- **CSS Modules** — scoped styling (variables in `src/styles/`)
- **Vitest** + Testing Library — tests

## Project Structure

```
src/
├── api/                    # API client and endpoints
│   ├── client.ts          # Fetch wrapper: cookie auth, tenant prefix, What-If interception
│   └── endpoints/         # Domain-specific API functions (projects.ts holds the
│                          #   snake_case↔camelCase transform layer)
├── components/
│   ├── admin/             # Admin portal (/admin) — separate app
│   ├── common/            # Shared UI components (Button, Modal, ContextMenu, …)
│   ├── gantt/             # Gantt chart (ProjectPanel tree + Timeline bars)
│   ├── layout/            # MainLayout, Header controls, Sidebar, ResourcePanel
│   ├── modals/            # Modal dialogs (lazy-loaded via ModalContainer)
│   ├── screens/           # Full-page screens (Login, Loading)
│   └── views/             # StaffView, EquipmentView, CrossSiteView, ArchivedView
├── contexts/               # WebSocketContext (live refetch), TimelineScrollContext
├── hooks/                  # Custom React hooks (drag/drop, undo, shortcuts, workload, …)
├── stores/                 # Zustand stores (see below)
├── styles/                 # Global styles and CSS variables
├── types/                  # TypeScript type definitions (models.ts)
└── utils/                  # date, storage, criticalPath, csvExport, xmlExport, …
```

## State Management

Seven Zustand stores in `src/stores/`:

1. **appStore** — domain data (sites, projects, staff, equipment, vacations, holidays, skills, tags, settings), auth, current site/user, critical path
2. **viewStore** — view mode/zoom, current view, tree expansion, scroll (persisted)
3. **uiStore** — transient UI: modals, drag/resize, dependency linking, context menus
4. **whatIfStore** — What-If sandbox (snapshot + queued operations)
5. **undoStore** — undo/redo snapshots (max 50)
6. **customColumnStore** — custom column data, filters, visibility
7. **adminStore** — admin portal state

```typescript
import { useAppStore } from '@/stores';

function MyComponent() {
  const { projects, currentSite } = useAppStore();
  // ...
}
```

## Getting Started

Prerequisites: Node.js 18+, npm 9+.

```bash
cd frontend
npm install
npm run dev        # dev server on http://localhost:3333
npm run build      # production build (tsc + vite)
npm run preview    # preview production build
npm test           # vitest watch mode
npm run test:ui    # vitest UI
npm run test:coverage
npm run lint       # eslint
```

**Backend required in dev**: there is no Vite API proxy — `src/api/client.ts` detects port 3333 and sends API/WebSocket traffic directly to the backend on port **8485**, so start the backend first (e.g. `docker compose -f docker-compose.dev.yml up` from the repo root runs both). The `tenantSpaPlugin` in `vite.config.ts` serves `/t/{slug}/…` SPA paths in dev, but full tenant/WebSocket behaviour is best tested against port 8485 serving the built frontend.

## API Calls

All API calls go through the centralized client, which handles:
- Tenant prefix detection (`/t/tenant-slug/api/...`)
- Session-cookie auth (`credentials: 'include'`)
- What-If mode interception (writes are queued, not sent, while What-If is active)
- Error formatting (FastAPI 422 details flattened)

```typescript
import { getProjects, createProject } from '@/api';

const projects = await getProjects();
const newProject = await createProject({ name: 'New Project', site_id: 1 });
```

Field-name transforms (snake_case↔camelCase, phase `type`↔`name`) live in `src/api/endpoints/projects.ts` — never transform in components.

## Styling

CSS Modules for component-scoped styles; CSS variables in `src/styles/` for colors and spacing. Themes set `data-theme` on `<html>` (see `src/utils/storage.ts`).

## Path Aliases

Use `@/` for imports (`@` → `src/`):

```typescript
import { useAppStore } from '@/stores';
```

## Integration with Backend

The FastAPI backend (port 8485) serves the built frontend from the repo-root `public/` directory — build with `npm run build`, then run `../deploy-react.sh` to copy `dist/` into `public/`.
