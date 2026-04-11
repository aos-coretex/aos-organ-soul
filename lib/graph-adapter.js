/**
 * Graph organ adapter — URN minting for Vivan personas.
 * Graph (#40) on port 4020 (AOS) / 3920 (SAAS).
 * Uses insertConcept to register a Vivan URN.
 *
 * Follows the Hippocampus graph-adapter pattern:
 *   1. Generate URN locally with urn:graphheight:vivan: prefix
 *   2. Register with Graph organ via HTTP POST /concepts
 *   3. Fail-open on Graph unavailability (local URN is valid)
 *
 * In target architecture, Graphheight service 511 mints URNs directly.
 */

/**
 * Mint a Vivan persona URN via Graph organ.
 * @param {string} graphUrl - Graph organ base URL (e.g. http://127.0.0.1:4020)
 * @param {object} [metadata] - Optional metadata for the concept
 * @returns {Promise<string>} - minted URN
 */
export async function mintVivanUrn(graphUrl, metadata = {}) {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  const urn = `urn:graphheight:vivan:${timestamp}-${rand}`;

  try {
    const response = await fetch(`${graphUrl}/concepts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urn,
        type: 'vivan',
        data: {
          ...metadata,
          organ: 'Soul',
          created_at: new Date().toISOString(),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Graph insertConcept failed: ${response.status}`);
    }

    return urn;
  } catch (error) {
    // Fail-open: generate URN locally if Graph is unavailable
    // Flag for reconciliation (URN_RESOLUTION_FAILED exception)
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'urn_resolution_failed',
      error: error.message,
      fallback_urn: urn,
    }));
    return urn;
  }
}

/**
 * Query Graph for the active Mission Statement Protocol (MSP) raw text.
 *
 * Used by Soul's evolution analyst to load the MSP as constitutional
 * conditioning context for persona synthesis (Cortex-role audit
 * Finding 2 resolution, 2026-04-11 YES position). Fail-open on any
 * error — returns null and the caller treats it as degraded mode.
 *
 * @param {string} graphUrl - Graph organ base URL
 * @returns {Promise<string|null>} active MSP raw_text, or null on failure
 */
export async function queryActiveMSP(graphUrl) {
  try {
    const url = `${graphUrl}/concepts/query?type=msp_version&status=active&limit=1`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const body = await response.json();
    const concepts = body.concepts || body.results || [];
    if (concepts.length === 0) return null;

    const first = concepts[0];
    const conceptData = first.data || {};
    const rawText = conceptData.raw_text;
    return typeof rawText === 'string' && rawText.length > 0 ? rawText : null;
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'msp_query_failed',
      error: error.message,
    }));
    return null;
  }
}
