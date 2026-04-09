/**
 * Vectr embedding client — generates 384-dim vectors for semantic search.
 * Soft-failure: if Vectr is unavailable, returns null (observation stored without embedding).
 */

/**
 * @param {string} text — Text to embed
 * @param {string} vectrUrl — Vectr service URL
 * @returns {Promise<number[]|null>} 384-dim vector or null
 */
export async function generateEmbedding(text, vectrUrl) {
  try {
    const res = await fetch(`${vectrUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding || null;
  } catch {
    return null;
  }
}

/**
 * Batch embed multiple texts.
 * @param {string[]} texts
 * @param {string} vectrUrl
 * @returns {Promise<(number[]|null)[]>}
 */
export async function batchEmbed(texts, vectrUrl) {
  return Promise.all(texts.map(t => generateEmbedding(t, vectrUrl)));
}

/**
 * Check if Vectr is reachable.
 */
export async function isVectrAvailable(vectrUrl) {
  try {
    const res = await fetch(`${vectrUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
