-- Soul Evolution schema v1 — Persona Definitions and Version History (Monad Leg 5)
-- Organ: #90 | Database: soul_evolution | No pgvector needed
-- Character: low volume, permanent, NEVER pruned
-- Source of truth: 01-Organs/90-Soul/soul-organ-definition.md

BEGIN;

-- Persona definitions — versioned snapshots of persona baselines
CREATE TABLE IF NOT EXISTS persona_definitions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vivan_urn             TEXT NOT NULL,
  version               INTEGER NOT NULL,
  baseline_json         JSONB NOT NULL,                    -- Full persona definition
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  superseded_at         TIMESTAMPTZ,
  changes_summary       TEXT,                              -- Human-readable delta from previous version
  UNIQUE(vivan_urn, version)
);

-- Persona registry — current state pointers for all personas
CREATE TABLE IF NOT EXISTS persona_registry (
  vivan_urn             TEXT PRIMARY KEY,
  current_version       INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'archived')),
  template_source       TEXT,                              -- Original MD template path
  total_observations    INTEGER DEFAULT 0,
  last_consistency_score REAL,
  last_evolved_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Evolution events — audit trail for persona transitions
CREATE TABLE IF NOT EXISTS evolution_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vivan_urn             TEXT NOT NULL,
  from_version          INTEGER NOT NULL,
  to_version            INTEGER NOT NULL,
  trigger_source        TEXT NOT NULL CHECK(trigger_source IN ('dream_cycle', 'manual', 'threshold')),
  reason                TEXT NOT NULL,                     -- Why this evolution was triggered
  evidence_refs         JSONB DEFAULT '[]',                -- [{observation_id, content_summary}]
  consistency_score_before REAL,
  consistency_score_after  REAL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes: persona_definitions
CREATE INDEX IF NOT EXISTS idx_defs_vivan ON persona_definitions (vivan_urn);
CREATE INDEX IF NOT EXISTS idx_defs_status ON persona_definitions (status);

-- Indexes: persona_registry
CREATE INDEX IF NOT EXISTS idx_registry_status ON persona_registry (status);

-- Indexes: evolution_events
CREATE INDEX IF NOT EXISTS idx_events_vivan ON evolution_events (vivan_urn);
CREATE INDEX IF NOT EXISTS idx_events_created ON evolution_events (created_at DESC);

COMMIT;
