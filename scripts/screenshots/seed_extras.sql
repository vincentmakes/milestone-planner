-- Extra demo data for screenshot captures.
-- Idempotent — safe to run multiple times.
-- Run against the demo tenant DB (milestone_demo) AFTER `app.scripts.seed_demo`:
--   docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \
--     < scripts/screenshots/seed_extras.sql

-- Vacations: gives Staff Overview vacation bars to display.
INSERT INTO vacations (staff_id, start_date, end_date, description) VALUES
  (2, '2026-05-04', '2026-05-15', 'Annual Leave'),
  (3, '2026-05-25', '2026-05-29', 'Conference - Berlin'),
  (4, '2026-06-08', '2026-06-12', 'Family Holiday'),
  (5, '2026-04-27', '2026-05-01', 'Spring Break')
ON CONFLICT DO NOTHING;

-- Swiss bank holidays for the Winterthur site (id 1).
INSERT INTO bank_holidays (site_id, date, name, year) VALUES
  (1, '2026-04-03', 'Good Friday',         2026),
  (1, '2026-04-06', 'Easter Monday',       2026),
  (1, '2026-05-01', 'Labour Day',          2026),
  (1, '2026-05-14', 'Ascension',           2026),
  (1, '2026-05-25', 'Whit Monday',         2026),
  (1, '2026-08-01', 'Swiss National Day',  2026)
ON CONFLICT DO NOTHING;

-- Custom columns + values at PHASE level (project rows show empty
-- placeholders; values render on phase/subphase rows).
INSERT INTO custom_columns (name, column_type, list_options, site_id, display_order, width) VALUES
  ('Priority', 'list',    '["High", "Medium", "Low"]', 1, 0, 110),
  ('Owner',    'text',    NULL,                         1, 1, 140),
  ('Reviewed', 'boolean', NULL,                         1, 2, 90)
ON CONFLICT DO NOTHING;

DELETE FROM custom_column_values
 WHERE custom_column_id IN (SELECT id FROM custom_columns WHERE name IN ('Priority','Owner','Reviewed'));

INSERT INTO custom_column_values (custom_column_id, entity_type, entity_id, value)
SELECT (SELECT id FROM custom_columns WHERE name='Priority'), 'phase', id,
       CASE (id % 3) WHEN 0 THEN 'Low' WHEN 1 THEN 'High' ELSE 'Medium' END
  FROM project_phases WHERE project_id IN (1,2,3);

INSERT INTO custom_column_values (custom_column_id, entity_type, entity_id, value)
SELECT (SELECT id FROM custom_columns WHERE name='Owner'), 'phase', id,
       (ARRAY['A. Anderson','B. Brown','C. Clark','D. Davis','E. Evans'])[(id % 5) + 1]
  FROM project_phases WHERE project_id IN (1,2,3);

INSERT INTO custom_column_values (custom_column_id, entity_type, entity_id, value)
SELECT (SELECT id FROM custom_columns WHERE name='Reviewed'), 'phase', id,
       CASE WHEN id % 3 = 0 THEN 'true' ELSE 'false' END
  FROM project_phases WHERE project_id IN (1,2,3) AND id % 2 = 1;
