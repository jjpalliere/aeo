-- Migration v2: add rationale to prompts + personas, supplement to brands
ALTER TABLE prompts ADD COLUMN rationale TEXT;
ALTER TABLE personas ADD COLUMN rationale TEXT;
ALTER TABLE brands ADD COLUMN supplement TEXT; -- ICP/persona text file content
