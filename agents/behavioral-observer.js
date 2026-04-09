/**
 * Behavioral Observer — Soul's first internal agent.
 *
 * Analyzes Vivan responses in completed conversations and extracts
 * atomic behavioral observations. Each observation is:
 * - Categorized: PREFERENCE | TRAIT | PATTERN | MOTIVATION | PREDICTION
 * - Scored: persona_relevance (0-1) — significance for persona evolution
 * - Embedded: 384-dim vector via Vectr for semantic search
 * - Stored: in soul_memory.persona_observations
 *
 * Model: Haiku (fast, cheap — high-volume observation extraction)
 *
 * RFI-2 fixes applied:
 *   1. Import from @coretex/organ-boot/llm-client (not root)
 *   2. System prompt via options.system (not messages array)
 *   3. persona_urn via conversation.participants?.persona_urn
 */
import { createLLMClient } from '@coretex/organ-boot/llm-client';
import { getMemoryPool } from '../server/db/memory-pool.js';
import { getEvolutionPool } from '../server/db/evolution-pool.js';
import { fetchConversation, fetchSessionConversations } from '../lib/hippocampus-client.js';
import { generateEmbedding } from '../lib/vectr-client.js';

const CATEGORIES = ['PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'];

const observer = createLLMClient({
  agentName: 'behavioral-observer',
  defaultModel: 'claude-haiku-4-5-20251001',
  defaultProvider: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  maxTokens: 2048,
});

/**
 * Process a conversation_completed trigger.
 * @param {object} event — Spine broadcast payload
 * @param {object} config — Soul config
 * @returns {Promise<{observations_created: number, errors: string[]}>}
 */
export async function onConversationCompleted(event, config) {
  const conversationUrn = event.conversation_urn || event.urn;
  if (!conversationUrn) {
    return { observations_created: 0, errors: ['No conversation_urn in event payload'] };
  }

  return processConversation(conversationUrn, 'conversation_completed', config);
}

/**
 * Process a session_end trigger (fallback for incomplete conversations).
 * @param {object} event — Spine broadcast payload
 * @param {object} config — Soul config
 * @returns {Promise<{observations_created: number, errors: string[]}>}
 */
export async function onSessionEnd(event, config) {
  const sessionId = event.session_id;
  if (!sessionId) {
    return { observations_created: 0, errors: ['No session_id in event payload'] };
  }

  // Fetch all active conversations from this session
  const conversations = await fetchSessionConversations(sessionId, config.hippocampusUrl);
  let totalCreated = 0;
  const allErrors = [];

  for (const conv of conversations) {
    if (conv.persona_urn) {  // Only observe conversations involving a Vivan
      const result = await processConversation(conv.urn, 'session_end', config);
      totalCreated += result.observations_created;
      allErrors.push(...result.errors);
    }
  }

  return { observations_created: totalCreated, errors: allErrors };
}

/**
 * Core observation extraction for a single conversation.
 */
async function processConversation(conversationUrn, triggerType, config) {
  const errors = [];

  // 1. Fetch full conversation from Hippocampus
  const data = await fetchConversation(conversationUrn, config.hippocampusUrl);
  if (!data) {
    return { observations_created: 0, errors: [`Failed to fetch conversation ${conversationUrn}`] };
  }

  const { conversation, messages } = data;
  if (!conversation || !messages || messages.length === 0) {
    return { observations_created: 0, errors: ['Empty conversation'] };
  }

  // 2. Identify Vivan participant (persona_urn is nested in participants)
  const vivanUrn = conversation.participants?.persona_urn;
  if (!vivanUrn) {
    return { observations_created: 0, errors: ['No persona_urn — not a Vivan conversation'] };
  }

  // 3. Check persona exists in soul_evolution
  const evoPool = getEvolutionPool();
  const registryResult = await evoPool.query(
    'SELECT * FROM persona_registry WHERE vivan_urn = $1 AND status = $2',
    [vivanUrn, 'active']
  );
  if (registryResult.rows.length === 0) {
    return { observations_created: 0, errors: [`Vivan ${vivanUrn} not registered or not active`] };
  }

  // 4. Load current baseline for context
  const registry = registryResult.rows[0];
  const baselineResult = await evoPool.query(
    'SELECT baseline_json FROM persona_definitions WHERE vivan_urn = $1 AND version = $2',
    [vivanUrn, registry.current_version]
  );
  const baseline = baselineResult.rows[0]?.baseline_json || {};

  // 5. Extract observations via LLM
  if (!observer.isAvailable()) {
    return { observations_created: 0, errors: ['LLM unavailable (ANTHROPIC_API_KEY not set)'] };
  }

  const vivanMessages = messages.filter(m => m.participant_urn === vivanUrn || m.role === 'assistant');
  if (vivanMessages.length === 0) {
    return { observations_created: 0, errors: ['No Vivan messages in conversation'] };
  }

  const observations = await extractObservations(vivanMessages, baseline, conversationUrn);
  if (observations.length === 0) {
    const log = { timestamp: new Date().toISOString(), event: 'no_observations', conversation: conversationUrn, vivan: vivanUrn };
    process.stdout.write(JSON.stringify(log) + '\n');
    return { observations_created: 0, errors: [] };
  }

  // 6. Generate embeddings (soft-failure)
  const embeddings = await Promise.all(
    observations.map(obs => generateEmbedding(obs.content, config.vectrUrl))
  );

  // 7. Store observations in soul_memory
  const memPool = getMemoryPool();
  let created = 0;

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    try {
      await memPool.query(`
        INSERT INTO persona_observations
          (vivan_urn, category, content, persona_relevance, source_conversation_urn, source_trigger, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        vivanUrn,
        obs.category,
        obs.content,
        obs.persona_relevance,
        conversationUrn,
        triggerType,
        embeddings[i],  // null if Vectr unavailable
      ]);
      created++;
    } catch (err) {
      errors.push(`Failed to store observation: ${err.message}`);
    }
  }

  // 8. Update observation count in persona_registry
  try {
    await evoPool.query(
      'UPDATE persona_registry SET total_observations = total_observations + $1, updated_at = NOW() WHERE vivan_urn = $2',
      [created, vivanUrn]
    );
  } catch (err) {
    errors.push(`Failed to update registry count: ${err.message}`);
  }

  const log = {
    timestamp: new Date().toISOString(),
    event: 'observations_stored',
    conversation: conversationUrn,
    vivan: vivanUrn,
    trigger: triggerType,
    count: created,
    embedded: embeddings.filter(e => e !== null).length,
  };
  process.stdout.write(JSON.stringify(log) + '\n');

  return { observations_created: created, errors };
}

/**
 * LLM-based observation extraction.
 * @param {object[]} vivanMessages — Messages from the Vivan
 * @param {object} baseline — Current persona baseline_json
 * @param {string} conversationUrn — Source conversation
 * @returns {Promise<{category: string, content: string, persona_relevance: number}[]>}
 */
async function extractObservations(vivanMessages, baseline, conversationUrn) {
  const messageText = vivanMessages
    .map((m, i) => `[${i + 1}] ${m.content}`)
    .join('\n\n');

  const systemPrompt = `You are a behavioral observation specialist for AI persona analysis.
You analyze an AI persona's responses and extract atomic behavioral observations.

PERSONA BASELINE (current definition):
${JSON.stringify(baseline, null, 2)}

CATEGORIES (classify each observation as exactly one):
- PREFERENCE: Stated or demonstrated preference (e.g., "prefers formal language in technical contexts")
- TRAIT: Personality characteristic (e.g., "shows curiosity when encountering unfamiliar topics")
- PATTERN: Recurring behavioral pattern (e.g., "consistently opens responses with a question")
- MOTIVATION: Underlying motivation or goal (e.g., "prioritizes user understanding over task completion speed")
- PREDICTION: Predictable future behavior based on evidence (e.g., "likely to push back on ambiguous requirements")

PERSONA_RELEVANCE (0.0 to 1.0):
- 0.0-0.3: Generic behavior (any AI would do this)
- 0.3-0.6: Somewhat characteristic (could distinguish this persona)
- 0.6-0.8: Strongly characteristic (defines this persona)
- 0.8-1.0: Core identity marker (fundamental to who this persona is)

RULES:
- Extract ONLY observations about the persona's behavior, NOT about the conversation content
- Each observation must be atomic (one behavioral fact per observation)
- Reference specific evidence from the messages
- Compare against the baseline — note deviations (both positive and negative)
- If the conversation is unremarkable (persona behaved exactly as baseline predicts), return an empty array
- Maximum 10 observations per conversation

OUTPUT FORMAT (JSON array):
[
  {
    "category": "TRAIT",
    "content": "Description of the behavioral observation with evidence reference",
    "persona_relevance": 0.7
  }
]

Return ONLY the JSON array. No wrapping text.`;

  const userMsg = `Analyze these responses from the persona and extract behavioral observations:\n\n${messageText}`;

  try {
    // System prompt via options.system (not messages array) — Anthropic API requirement
    const result = await observer.chat([
      { role: 'user', content: userMsg },
    ], { system: systemPrompt, temperature: 0.3 });

    // Parse JSON response
    const text = result.content.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    // Validate and filter
    return parsed.filter(obs => {
      if (!obs.category || !CATEGORIES.includes(obs.category)) return false;
      if (!obs.content || typeof obs.content !== 'string') return false;
      if (typeof obs.persona_relevance !== 'number') return false;
      if (obs.persona_relevance < 0 || obs.persona_relevance > 1) return false;
      return true;
    });
  } catch (err) {
    const log = { timestamp: new Date().toISOString(), event: 'observation_extraction_error', error: err.message };
    process.stdout.write(JSON.stringify(log) + '\n');
    return [];
  }
}

export { extractObservations };
