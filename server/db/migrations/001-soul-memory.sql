-- Soul Memory schema v1 — Behavioral Observations (Monad Leg 5)
-- Organ: #90 | Database: soul_memory | Extension: pgvector
-- Character: high volume, append-heavy, prunable via dream cycle
-- Source of truth: 01-Organs/90-Soul/soul-organ-definition.md

BEGIN;

-- Extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Persona observations — atomic behavioral data extracted from conversations
CREATE TABLE IF NOT EXISTS persona_observations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vivan_urn             TEXT NOT NULL,                     -- Graphheight-minted persona URN
  category              TEXT NOT NULL CHECK(category IN (
                          'PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'
                        )),
  content               TEXT NOT NULL,                     -- Observation text
  persona_relevance     REAL NOT NULL CHECK(persona_relevance BETWEEN 0 AND 1),
                                                           -- How significant for persona evolution
  source_conversation_urn TEXT NOT NULL,                   -- Hippocampus conversation URN
  source_trigger        TEXT NOT NULL DEFAULT 'conversation_completed' CHECK(
                          source_trigger IN ('conversation_completed', 'session_end')
                        ),
  embedding             vector(384),                       -- Vectr-generated for semantic search
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Behavioral patterns — dream-derived clusters of related observations
CREATE TABLE IF NOT EXISTS behavioral_patterns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vivan_urn             TEXT NOT NULL,
  pattern_description   TEXT NOT NULL,
  category              TEXT NOT NULL CHECK(category IN (
                          'PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'
                        )),
  evidence_count        INTEGER DEFAULT 1,
  observation_ids       UUID[] DEFAULT '{}',               -- Source observations
  embedding             vector(384),
  first_seen            TIMESTAMPTZ DEFAULT NOW(),
  last_seen             TIMESTAMPTZ DEFAULT NOW()
);

-- Consistency checks — drift/growth analysis results
CREATE TABLE IF NOT EXISTS consistency_checks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vivan_urn             TEXT NOT NULL,
  baseline_version      INTEGER NOT NULL,                  -- persona_definitions version checked against
  consistency_score     REAL NOT NULL CHECK(consistency_score BETWEEN 0 AND 1),
  classification        TEXT NOT NULL CHECK(classification IN ('stable', 'monitor', 'intervene')),
  drift_count           INTEGER DEFAULT 0,
  growth_count          INTEGER DEFAULT 0,
  drift_items           JSONB DEFAULT '[]',                -- [{observation_id, description, severity}]
  growth_items          JSONB DEFAULT '[]',                -- [{observation_id, description, strength}]
  checked_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Dream log — persona dream cycle execution records
CREATE TABLE IF NOT EXISTS dream_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_number          INTEGER NOT NULL,
  started_at            TIMESTAMPTZ DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  observations_pruned   INTEGER DEFAULT 0,
  patterns_updated      INTEGER DEFAULT 0,
  evolutions_triggered  INTEGER DEFAULT 0,
  personas_checked      INTEGER DEFAULT 0,
  summary               TEXT,
  status                TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed'))
);

-- Indexes: persona_observations
CREATE INDEX IF NOT EXISTS idx_obs_vivan ON persona_observations (vivan_urn);
CREATE INDEX IF NOT EXISTS idx_obs_category ON persona_observations (category);
CREATE INDEX IF NOT EXISTS idx_obs_conversation ON persona_observations (source_conversation_urn);
CREATE INDEX IF NOT EXISTS idx_obs_created ON persona_observations (created_at DESC);

-- Vector indexes (ivfflat) — lists=1 for dev, rebuild at scale
CREATE INDEX IF NOT EXISTS idx_obs_embedding
  ON persona_observations USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);
CREATE INDEX IF NOT EXISTS idx_patterns_embedding
  ON behavioral_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1);

-- Indexes: behavioral_patterns
CREATE INDEX IF NOT EXISTS idx_patterns_vivan ON behavioral_patterns (vivan_urn);

-- Indexes: consistency_checks
CREATE INDEX IF NOT EXISTS idx_checks_vivan ON consistency_checks (vivan_urn);
CREATE INDEX IF NOT EXISTS idx_checks_score ON consistency_checks (consistency_score);

COMMIT;
