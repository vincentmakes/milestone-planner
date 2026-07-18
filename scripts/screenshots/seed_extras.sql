-- Extra demo data for screenshot captures.
-- Idempotent — safe to run multiple times.
-- Run against the demo tenant DB (milestone_demo) AFTER `app.scripts.seed_demo`:
--   docker exec -i milestone-fresh-db psql -U milestone_demo -d milestone_demo \
--     < scripts/screenshots/seed_extras.sql

-- Vacations: gives Staff Overview vacation bars to display.
-- (vacations has no unique constraint, so ON CONFLICT can't be used here —
--  guard with NOT EXISTS to stay idempotent.)
INSERT INTO vacations (staff_id, start_date, end_date, description)
SELECT v.staff_id, v.start_date::date, v.end_date::date, v.description
  FROM (VALUES
    (2, '2026-05-04', '2026-05-15', 'Annual Leave'),
    (3, '2026-05-25', '2026-05-29', 'Conference - Berlin'),
    (4, '2026-06-08', '2026-06-12', 'Family Holiday'),
    (5, '2026-04-27', '2026-05-01', 'Spring Break')
  ) AS v(staff_id, start_date, end_date, description)
 WHERE NOT EXISTS (SELECT 1 FROM vacations x
                    WHERE x.staff_id = v.staff_id AND x.description = v.description);

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
-- (custom_columns has no unique constraint on name, so ON CONFLICT can't be
--  used here — guard with NOT EXISTS to stay idempotent.)
INSERT INTO custom_columns (name, column_type, list_options, site_id, display_order, width)
SELECT v.name, v.column_type, v.list_options, 1, v.display_order, v.width
  FROM (VALUES
    ('Priority', 'list',    '["High", "Medium", "Low"]', 0, 110),
    ('Owner',    'text',    NULL,                        1, 140),
    ('Reviewed', 'boolean', NULL,                        2, 90)
  ) AS v(name, column_type, list_options, display_order, width)
 WHERE NOT EXISTS (SELECT 1 FROM custom_columns c WHERE c.name = v.name);

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

-- Project tags: gives the Gantt tag chips + the tag picker real data.
INSERT INTO tags (name, color) VALUES
  ('Critical',      '#ef4444'),
  ('Internal',      '#6366f1'),
  ('Tech Transfer', '#10b981')
ON CONFLICT (name) DO NOTHING;

INSERT INTO project_tags (project_id, tag_id)
SELECT p.id, t.id FROM projects p, tags t
 WHERE (p.name = 'Bioprocess Scale-Up'        AND t.name IN ('Critical', 'Tech Transfer'))
    OR (p.name = 'Catalyst Optimization'      AND t.name = 'Critical')
    OR (p.name = 'Quality System Upgrade'     AND t.name = 'Internal')
ON CONFLICT DO NOTHING;

-- Equipment blocks: a current maintenance window (shows "Blocked" today on
-- the Equipment view) plus an upcoming defect block.
INSERT INTO equipment_blocks (equipment_id, start_date, end_date, reason, description)
SELECT e.id, CURRENT_DATE - 2, CURRENT_DATE + 5, 'maintenance', 'Annual preventive maintenance'
  FROM equipment e
 WHERE e.name = 'HPLC System 1'
   AND NOT EXISTS (SELECT 1 FROM equipment_blocks b
                    WHERE b.equipment_id = e.id AND b.reason = 'maintenance');

INSERT INTO equipment_blocks (equipment_id, start_date, end_date, reason, description)
SELECT e.id, CURRENT_DATE + 20, CURRENT_DATE + 24, 'defect', 'Detector lamp replacement'
  FROM equipment e
 WHERE e.name = 'Mass Spectrometer'
   AND NOT EXISTS (SELECT 1 FROM equipment_blocks b
                    WHERE b.equipment_id = e.id AND b.reason = 'defect');

-- Staff note: keeps the demo tenant canonical for the site Excel export
-- ("Staff notes" sheet). There is no UI for notes yet.
INSERT INTO staff_notes (site_id, staff_id, date, text, type)
SELECT 1, u.id, CURRENT_DATE + 7, 'Covering weekend shift for stability study sampling', 'general'
  FROM users u
 WHERE u.email = 'alice.anderson@demo.local'
   AND NOT EXISTS (SELECT 1 FROM staff_notes WHERE site_id = 1);
