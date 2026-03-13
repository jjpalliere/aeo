-- Simulate API DELETE cascade for dummy run
DELETE FROM brand_mentions WHERE query_id IN (SELECT id FROM queries WHERE run_id = 'dummy-run-delete-test');
DELETE FROM citations WHERE query_id IN (SELECT id FROM queries WHERE run_id = 'dummy-run-delete-test');
DELETE FROM queries WHERE run_id = 'dummy-run-delete-test';
DELETE FROM runs WHERE id = 'dummy-run-delete-test';
