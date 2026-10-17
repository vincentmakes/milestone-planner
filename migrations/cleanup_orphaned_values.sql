-- Migration: remove orphaned custom-column values and card comments (PostgreSQL)
-- Description: custom_column_values and card_comments reference their
--              project / phase / subphase through a polymorphic
--              (entity_type, entity_id) pair with no FK. Deleting a project
--              (or a site with its projects) used to leave them behind, and
--              GET /custom-columns/with-values shipped the dead values to every
--              client on every load. The delete handlers now remove them; this
--              clears what older releases left.
--
-- USAGE: python migrations/run_migration.py cleanup_orphaned_values
--    or: psql -d <tenant_db> -f migrations/cleanup_orphaned_values.sql
--
-- Idempotent (DELETE ... WHERE NOT EXISTS). The same statements
-- (tenant_provisioner.CUSTOM_COLUMN_VALUES_ORPHAN_CLEANUP_SQL /
-- CARD_COMMENTS_ORPHAN_CLEANUP_SQL) also run automatically on tenant pool
-- creation (app.services.tenant_data_migrations) and in get_tenant_schema_sql()
-- / setup_databases.sql.

DELETE FROM custom_column_values v
WHERE (v.entity_type = 'project'
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v.entity_id))
   OR (v.entity_type = 'phase'
       AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = v.entity_id))
   OR (v.entity_type = 'subphase'
       AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = v.entity_id));

DELETE FROM card_comments cc
WHERE (cc.entity_type = 'phase'
       AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.id = cc.entity_id))
   OR (cc.entity_type = 'subphase'
       AND NOT EXISTS (SELECT 1 FROM project_subphases sp WHERE sp.id = cc.entity_id));
