-- Migration: Add role-based access control, approvals and todos (PostgreSQL)
-- Description: Creates roles (the admin / superuser / user system roles plus
-- custom roles), role_permissions (one row per granted permission key, mode
-- allow or approval; no row = deny; the admin role has none, it holds every
-- permission in code), approval_policies / approval_policy_roles (who approves
-- an own booking: the project manager and/or roles), approval_requests and
-- todos. Adds approval_status / approval_request_id to the three staff
-- assignment tables (pending self-bookings are real rows), widens the
-- notification types, drops the sso_config default-role CHECK (roles are
-- editable; validated in code), seeds the system roles with their default
-- permissions (defaults that reproduce the pre-RBAC behaviour, inserted only
-- for a role row created by this run) and one policy per approvable action,
-- and replaces the users.role CHECK with a foreign key to roles.key.
--
-- USAGE: Run this on each existing tenant database
-- Example: python migrations/run_migration.py add_rbac
--   or:    psql -h localhost -U postgres -d tenant_db -f migrations/add_rbac.sql
--
-- Idempotent. The tenant auto-migration (tenant_manager._run_auto_migrations)
-- applies the same statements (tenant_provisioner.RBAC_SCHEMA_STATEMENTS) when
-- a tenant pool is created, and tenant_data_migrations.RBAC_SEED_STEP runs the
-- seed and the users.role swap (tenant_provisioner.RBAC_SEED_STATEMENTS)
-- (1.13.0).
--
-- NOTE: Run as database superuser (postgres) to ensure proper grants

-- Roles and their permission rows
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    key VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,19}$')
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission VARCHAR(60) NOT NULL,
    mode VARCHAR(10) NOT NULL DEFAULT 'allow',
    PRIMARY KEY (role_id, permission),
    CONSTRAINT role_permissions_mode_check CHECK (mode IN ('allow', 'approval'))
);

-- Approval policies (per approvable action) and their approver roles
CREATE TABLE IF NOT EXISTS approval_policies (
    action VARCHAR(60) PRIMARY KEY,
    pm_approves BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approval_policy_roles (
    action VARCHAR(60) NOT NULL REFERENCES approval_policies(action) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (action, role_id)
);

-- Approval requests (assignment_id points into the assignment table chosen by level)
CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action VARCHAR(60) NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    level VARCHAR(10) NOT NULL,
    target_id INTEGER NOT NULL,
    assignment_id INTEGER,
    requested TEXT,
    previous TEXT,
    note TEXT,
    status VARCHAR(12) NOT NULL DEFAULT 'pending',
    close_reason VARCHAR(20),
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMP,
    decision_note TEXT,
    superseded_by_id INTEGER REFERENCES approval_requests(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT approval_requests_level_check CHECK (level IN ('project', 'phase', 'subphase')),
    CONSTRAINT approval_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded', 'expired')),
    CONSTRAINT approval_requests_close_reason_check CHECK (close_reason IN ('target_deleted', 'requester_inactive', 'permission_lost', 'overtaken', 'duplicate'))
);

-- Todos (My Todos)
CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    notes TEXT,
    due_date DATE,
    assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open',
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    entity_type VARCHAR(20),
    entity_id INTEGER,
    completed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT todos_status_check CHECK (status IN ('open', 'done', 'cancelled')),
    CONSTRAINT todos_entity_type_check CHECK (entity_type IN ('phase', 'subphase'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_approval_policy_roles_role ON approval_policy_roles(role_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_project_status ON approval_requests(project_id, status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_requester_status ON approval_requests(requester_id, status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_todos_assignee_status ON todos(assignee_id, status);

-- Staff assignments: approval_status + the open approval request
DO $$
BEGIN
    IF to_regclass('public.project_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE project_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT project_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.project_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE project_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT project_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT phase_staff_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.phase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'phase_staff_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE phase_staff_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT phase_staff_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'approval_status'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'approved' CONSTRAINT subphase_staff_assignments_approval_status_check CHECK (approval_status IN ('approved', 'pending'));
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.subphase_staff_assignments') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subphase_staff_assignments'
          AND column_name = 'approval_request_id'
    ) THEN
        ALTER TABLE subphase_staff_assignments ADD COLUMN approval_request_id INTEGER CONSTRAINT subphase_staff_assignments_approval_request_id_fkey REFERENCES approval_requests(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Notification types for approvals and todos
DO $$
BEGIN
    IF to_regclass('public.notifications') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.notifications')
          AND conname = 'notifications_type_check'
          AND strpos(pg_get_constraintdef(oid), 'project_changed') > 0
    ) THEN
        ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
        ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
            CHECK (type IN ('assigned', 'comment', 'mention', 'status_change', 'approval_requested', 'approval_decided', 'todo_assigned', 'assignment_changed', 'project_changed'));
    END IF;
END $$;

-- sso_config.default_role becomes a role key (validated in code)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sso_config')
          AND conname = 'sso_config_default_role_check'
    ) THEN
        ALTER TABLE sso_config DROP CONSTRAINT sso_config_default_role_check;
    END IF;
END $$;

-- System roles with their default permissions (only for roles created now)
WITH new_roles AS (
  INSERT INTO roles (key, name, description, is_system, sort_order)
  VALUES
    ('admin', 'Administrator', 'Holds every permission. Cannot be edited or deleted.', TRUE, 0),
    ('superuser', 'Superuser', 'Plans projects, staff and equipment at their sites.', TRUE, 1),
    ('user', 'User', 'Sees the plan, books themself and manages their own absences.', TRUE, 2)
  ON CONFLICT (key) DO NOTHING
  RETURNING id, key
)
INSERT INTO role_permissions (role_id, permission, mode)
SELECT r.id, d.permission, d.mode
FROM new_roles r JOIN (VALUES
  ('superuser', 'projects.view', 'allow'),
  ('superuser', 'projects.create', 'allow'),
  ('superuser', 'projects.edit_any', 'allow'),
  ('superuser', 'projects.manage_as_pm', 'allow'),
  ('superuser', 'projects.archive', 'allow'),
  ('superuser', 'projects.delete', 'allow'),
  ('superuser', 'projects.import', 'allow'),
  ('superuser', 'projects.export', 'allow'),
  ('superuser', 'assignments.manage_others', 'allow'),
  ('superuser', 'assignments.self_create', 'allow'),
  ('superuser', 'assignments.self_update', 'allow'),
  ('superuser', 'assignments.self_remove', 'allow'),
  ('superuser', 'equipment_bookings.manage', 'allow'),
  ('superuser', 'kanban.move_any', 'allow'),
  ('superuser', 'kanban.move_assigned', 'allow'),
  ('superuser', 'kanban.comment', 'allow'),
  ('superuser', 'kanban.moderate_comments', 'allow'),
  ('superuser', 'custom_columns.set_values', 'allow'),
  ('superuser', 'absences.view_others', 'allow'),
  ('superuser', 'absences.manage_own', 'allow'),
  ('superuser', 'absences.manage_others', 'allow'),
  ('superuser', 'staff_notes.manage', 'allow'),
  ('superuser', 'equipment.manage', 'allow'),
  ('superuser', 'equipment_types.manage', 'allow'),
  ('superuser', 'equipment_blocks.manage', 'allow'),
  ('superuser', 'bank_holidays.manage', 'allow'),
  ('superuser', 'company_events.manage', 'allow'),
  ('superuser', 'sites.export', 'allow'),
  ('superuser', 'teams.manage', 'allow'),
  ('superuser', 'users.view', 'allow'),
  ('superuser', 'users.edit', 'allow'),
  ('superuser', 'skills.manage', 'allow'),
  ('superuser', 'skills.assign', 'allow'),
  ('superuser', 'predefined_phases.manage', 'allow'),
  ('superuser', 'todos.manage_own', 'allow'),
  ('superuser', 'todos.assign_others', 'allow'),
  ('superuser', 'views.kanban', 'allow'),
  ('superuser', 'views.staff', 'allow'),
  ('superuser', 'views.equipment', 'allow'),
  ('superuser', 'views.crosssite', 'allow'),
  ('superuser', 'views.archived', 'allow'),
  ('superuser', 'whatif.use', 'allow'),
  ('user', 'projects.view', 'allow'),
  ('user', 'projects.manage_as_pm', 'allow'),
  ('user', 'assignments.self_create', 'allow'),
  ('user', 'assignments.self_update', 'allow'),
  ('user', 'assignments.self_remove', 'allow'),
  ('user', 'kanban.move_assigned', 'allow'),
  ('user', 'kanban.comment', 'allow'),
  ('user', 'custom_columns.set_values', 'allow'),
  ('user', 'absences.view_others', 'allow'),
  ('user', 'absences.manage_own', 'allow'),
  ('user', 'todos.manage_own', 'allow'),
  ('user', 'views.kanban', 'allow'),
  ('user', 'views.staff', 'allow'),
  ('user', 'views.equipment', 'allow'),
  ('user', 'views.crosssite', 'allow'),
  ('user', 'views.archived', 'allow')
) AS d(role_key, permission, mode) ON d.role_key = r.key
ON CONFLICT (role_id, permission) DO NOTHING;

-- One approval policy per approvable action: the project manager approves
INSERT INTO approval_policies (action, pm_approves) VALUES
  ('assignments.self_create', TRUE),
  ('assignments.self_update', TRUE),
  ('assignments.self_remove', TRUE)
ON CONFLICT (action) DO NOTHING;

-- users.role: unknown values fall back to 'user', then the CHECK becomes the FK
UPDATE users SET role = 'user' WHERE role NOT IN (SELECT key FROM roles);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_check'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
    END IF;
    IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.users') AND conname = 'users_role_fkey'
    ) THEN
        ALTER TABLE users ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;

-- Grant permissions to the database owner/app user
DO $$
DECLARE
    db_owner TEXT;
BEGIN
    SELECT pg_catalog.pg_get_userbyid(d.datdba) INTO db_owner
    FROM pg_catalog.pg_database d
    WHERE d.datname = current_database();

    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE roles TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE role_permissions TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE approval_policies TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE approval_policy_roles TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE approval_requests TO %I', db_owner);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE todos TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE roles_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE approval_requests_id_seq TO %I', db_owner);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO %I', db_owner);

    RAISE NOTICE 'Granted permissions to database owner: %', db_owner;
END $$;

-- Verify migration
DO $$
BEGIN
    RAISE NOTICE 'RBAC migration completed successfully';
    RAISE NOTICE 'Tables created: roles, role_permissions, approval_policies, approval_policy_roles, approval_requests, todos';
END $$;
