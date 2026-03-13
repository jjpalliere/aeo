-- Insert a dummy run for testing DELETE cascade
-- Requires: a brand exists. Use first brand or create one.
INSERT OR IGNORE INTO brands (id, url, domain, name, status) 
VALUES ('dummy-brand-delete-test', 'https://dummy.test', 'dummy.test', 'Dummy Delete Test', 'ready');

INSERT OR REPLACE INTO runs (id, brand_id, status, total_queries, completed_queries) 
VALUES ('dummy-run-delete-test', 'dummy-brand-delete-test', 'complete', 1, 1);

INSERT OR IGNORE INTO prompts (id, brand_id, text, funnel_stage) 
VALUES ('dummy-prompt-delete-test', 'dummy-brand-delete-test', 'Dummy prompt for delete test', 'tofu');

INSERT OR IGNORE INTO personas (id, brand_id, name, description, system_message) 
VALUES ('dummy-persona-delete-test', 'dummy-brand-delete-test', 'Dummy', 'Test', 'You are helpful.');

INSERT OR REPLACE INTO queries (id, run_id, prompt_id, persona_id, llm, response_text, status) 
VALUES ('dummy-query-delete-test', 'dummy-run-delete-test', 'dummy-prompt-delete-test', 'dummy-persona-delete-test', 'claude', 'Dummy response', 'complete');

INSERT OR REPLACE INTO citations (id, query_id, url, domain, page_title, company_name, source_type) 
VALUES ('dummy-citation-delete-test', 'dummy-query-delete-test', 'https://dummy.test/page', 'dummy.test', 'Dummy Page', 'Dummy Co', 'competitor');

INSERT OR REPLACE INTO brand_mentions (id, query_id, brand_name, rank, is_target, context_snippet, positioning) 
VALUES ('dummy-mention-delete-test', 'dummy-query-delete-test', 'Dummy Delete Test', 1, 1, 'dummy context', 'dummy positioning');
