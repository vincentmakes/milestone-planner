# Milestone Frontend (React)

This is the React-based frontend for Milestone, migrated from the vanilla JavaScript implementation.

## Tech Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Zustand** - State management
- **TanStack Query** - Data fetching and caching
- **date-fns** - Date utilities
- **CSS Modules** - Scoped styling

## Project Structure

```
src/
├── api/                    # API client and endpoints
│   ├── client.ts          # Base fetch wrapper with tenant support
│   └── endpoints/         # Domain-specific API functions
├── components/
│   ├── common/            # Shared UI components (Button, Modal, etc.)
│   ├── gantt/             # Gantt chart components
│   ├── layout/            # Layout components (Header, Sidebar, etc.)
│   ├── modals/            # Modal dialogs
│   ├── screens/           # Full-page screens (Login, Loading)
│   └── views/             # View components (Staff, Equipment, etc.)
├── hooks/                 # Custom React hooks
├── stores/                # Zustand state stores
│   ├── appStore.ts        # Main application state
│   ├── uiStore.ts         # UI state (modals, tooltips, etc.)
│   └── undoStore.ts       # Undo/redo history
├── styles/                # Global styles and CSS variables
├── types/                 # TypeScript type definitions
└── utils/                 # Utility functions
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
cd frontend
npm install
```

### Development

```bash
# Start dev server (with proxy to backend on port 8000)
npm run dev

# The app will be available at http://localhost:3000
```

### Building

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

### Testing

```bash
# Run tests
npm test

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

## Development Guidelines

### State Management

We use Zustand for state management with three stores:

1. **appStore** - Main application state (sites, projects, staff, etc.)
2. **uiStore** - Transient UI state (modals, tooltips, drag state)
3. **undoStore** - Undo/redo history for Gantt operations

```typescript
import { useAppStore } from '@/stores';

function MyComponent() {
  const { projects, currentSite } = useAppStore();
  // ...
}
```

### API Calls

All API calls go through the centralized API client which handles:
- Tenant prefix detection (`/t/tenant-slug/api/...`)
- What If mode request blocking
- Error handling

```typescript
import { getProjects, createProject } from '@/api';

// GET request
const projects = await getProjects();

// POST request
const newProject = await createProject({ name: 'New Project', site_id: 1 });
```

### Styling

We use CSS Modules for component-scoped styles:

```tsx
import styles from './MyComponent.module.css';

function MyComponent() {
  return <div className={styles.container}>...</div>;
}
```

CSS variables are defined in `src/styles/variables.css` and should be used for colors, spacing, etc.

### Path Aliases

Use the `@/` alias for imports:

```typescript
// Instead of:
import { useAppStore } from '../../../stores';

// Use:
import { useAppStore } from '@/stores';
```

## Migration Status

### Phase 1: Foundation ✅
- [x] Project scaffolding (Vite + React + TypeScript)
- [x] TypeScript types for all domain models
- [x] Zustand stores (appStore, uiStore, undoStore)
- [x] API client with tenant prefix support
- [x] CSS variables and theme system
- [x] Authentication hook and flow
- [x] Data loader hook
- [x] Loading and Login screens

### Phase 2: Core Layout (Next)
- [ ] Header with sub-components
- [ ] Sidebar with navigation
- [ ] Resource panel
- [ ] Modal system

### Phase 3-8: See REACT_MIGRATION_PLAN.md

## Integration with Backend

The frontend expects the FastAPI backend to be running on port 8000. The Vite dev server is configured to proxy `/api` requests to the backend.

For production, nginx should be configured to serve the built frontend and proxy API requests to the backend.
