# Soul Organ (#90)

## Identity

- **Organ:** Soul (Persona Memory)
- **Number:** 90
- **Profile:** Probabilistic
- **Artifact:** database
- **Monad Leg:** 5
- **Ports:** 4009 (AOS) / 3909 (SAAS)
- **Binding:** 127.0.0.1

## Two Databases

Soul is the only organ with two encapsulated databases:

| Database | Engine | Purpose | Character |
|---|---|---|---|
| `soul_memory` | PostgreSQL 17 + pgvector | Behavioral observations, consistency checks, dream logs | High volume, append-heavy, prunable via dream cycle |
| `soul_evolution` | PostgreSQL 17 | Persona definitions, version history, evolution audit trail | Low volume, permanent, NEVER pruned |

Both on localhost:5432, user `graphheight_sys`.

## Dependencies

| Organ | AOS Port | Purpose |
|---|---|---|
| Spine | 4000 | Message bus (WebSocket + HTTP) |
| Hippocampus | 4008 | Conversation completion events trigger observation |
| Vectr | 4001 | 384-dim embedding generation for observations |
| Graph | 4020 | URN minting for persona identity |

## Key Modules

- `@coretex/organ-boot` — boot factory (`createOrgan()`), Spine client, health/introspect, live loop
- `llm-client` (from organ-shared-lib) — internal service agents
- `lib/vectr-client.js` — Vectr embedding (384-dim, cosine similarity)
- `lib/graph-adapter.js` — Graph organ URN minting
- `lib/template-parser.js` — MD persona template to JSON

## Internal Service Agents

| Agent | Model | Purpose |
|---|---|---|
| Behavioral observer | Haiku | Extract observations from conversation history |
| Consistency checker | Sonnet | Drift vs growth classification against persona baseline |
| Evolution analyst | Sonnet | Synthesize updated persona definition from observations |
| Dream cycle | — | Consolidation, pruning, consistency metrics |

## Observation Categories (Soul's Own Taxonomy)

PREFERENCE, TRAIT, PATTERN, MOTIVATION, PREDICTION

These are Soul's categories — distinct from Minder's observation levels (explicit/deductive/inductive).

## Running

```bash
npm install                  # Install dependencies
npm test                     # Run tests (serial, avoids dual-DB contention)
npm run setup-db             # Create both databases + apply migrations
SOUL_PORT=4009 npm start     # Start organ (requires Spine + dependencies)
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages

## Conventions

- ES modules (import/export)
- Node.js built-in test runner (`node --test`)
- Structured JSON logging to stdout
- Express 5 path patterns (from organ-shared-lib)

## Completed Relays

- Relay 1 (u7h-1): Project scaffold + dual database schemas
