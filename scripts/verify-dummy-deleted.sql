-- Verify dummy run and all related data are gone after DELETE
SELECT 'runs' as tbl, COUNT(*) as cnt FROM runs WHERE id = 'dummy-run-delete-test'
UNION ALL SELECT 'queries', COUNT(*) FROM queries WHERE run_id = 'dummy-run-delete-test'
UNION ALL SELECT 'citations', COUNT(*) FROM citations WHERE query_id = 'dummy-query-delete-test'
UNION ALL SELECT 'brand_mentions', COUNT(*) FROM brand_mentions WHERE query_id = 'dummy-query-delete-test';
