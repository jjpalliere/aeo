-- Add persona_id to prompts table for persona-specific prompt generation
ALTER TABLE prompts ADD COLUMN persona_id TEXT REFERENCES personas(id);
CREATE INDEX IF NOT EXISTS idx_prompts_persona ON prompts(persona_id);
