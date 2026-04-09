/**
 * Hippocampus HTTP client — fetch conversation data for behavioral observation.
 * Soul reads from Hippocampus via HTTP (same pattern as Phi's loadLeg4).
 *
 * Response normalization: Hippocampus GET /conversations/:urn returns a flat
 * object with messages as a property. This client normalizes to
 * { conversation, messages } for the observer's expected shape.
 */

/**
 * Fetch a complete conversation with all messages.
 * @param {string} conversationUrn — Hippocampus conversation URN
 * @param {string} hippocampusUrl — Hippocampus service URL
 * @returns {Promise<{conversation: object, messages: object[]}|null>}
 */
export async function fetchConversation(conversationUrn, hippocampusUrl) {
  try {
    const res = await fetch(
      `${hippocampusUrl}/conversations/${encodeURIComponent(conversationUrn)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) {
      const log = { timestamp: new Date().toISOString(), event: 'hippocampus_fetch_failed', urn: conversationUrn, status: res.status };
      process.stdout.write(JSON.stringify(log) + '\n');
      return null;
    }
    // Hippocampus returns flat object with messages included by default.
    // Normalize to { conversation, messages } for observer consumption.
    const raw = await res.json();
    return {
      conversation: raw,
      messages: raw.messages || [],
    };
  } catch (err) {
    const log = { timestamp: new Date().toISOString(), event: 'hippocampus_fetch_error', urn: conversationUrn, error: err.message };
    process.stdout.write(JSON.stringify(log) + '\n');
    return null;
  }
}

/**
 * Fetch conversations for a session (session_end trigger — may have multiple conversations).
 * Note: Hippocampus list endpoint does not currently support agent_session filtering.
 * The parameter is included for forward compatibility — when Hippocampus adds
 * agent_session filtering, this client will work without changes.
 * @param {string} sessionId
 * @param {string} hippocampusUrl
 * @returns {Promise<object[]>}
 */
export async function fetchSessionConversations(sessionId, hippocampusUrl) {
  try {
    const res = await fetch(
      `${hippocampusUrl}/conversations?agent_session=${encodeURIComponent(sessionId)}&status=active`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.conversations || [];
  } catch {
    return [];
  }
}
