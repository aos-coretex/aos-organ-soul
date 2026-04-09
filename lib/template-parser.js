/**
 * Parse persona template markdown into baseline_json.
 * Templates: YAML frontmatter + optional markdown body.
 * Validation: name (required), traits (non-empty array), voice (object with tone + style).
 */

/**
 * @param {string} content — Raw markdown file content
 * @returns {{ baseline: object, errors: string[] }}
 */
export function parseTemplate(content) {
  const errors = [];

  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { baseline: null, errors: ['No YAML frontmatter found (expected --- delimiters)'] };
  }

  const frontmatter = parseFrontmatter(fmMatch[1]);
  if (frontmatter.error) {
    return { baseline: null, errors: [frontmatter.error] };
  }

  const fm = frontmatter.data;

  // Extract body (everything after second ---)
  const bodyStart = content.indexOf('---', content.indexOf('---') + 3) + 3;
  const body = content.slice(bodyStart).trim();

  // Validate required fields
  if (!fm.name || typeof fm.name !== 'string') {
    errors.push('Missing required field: name (string)');
  }
  if (!Array.isArray(fm.traits) || fm.traits.length === 0) {
    errors.push('Missing required field: traits (non-empty array)');
  }
  if (!fm.voice || typeof fm.voice !== 'object') {
    errors.push('Missing required field: voice (object)');
  } else {
    if (!fm.voice.tone) errors.push('Missing required field: voice.tone');
    if (!fm.voice.style) errors.push('Missing required field: voice.style');
  }

  if (errors.length > 0) {
    return { baseline: null, errors };
  }

  // Build baseline_json
  const baseline = {
    name: fm.name,
    traits: fm.traits,
    constraints: fm.constraints || [],
    voice: fm.voice,
    knowledge_domains: fm.knowledge_domains || [],
    behavioral_boundaries: fm.behavioral_boundaries || [],
  };

  if (body) {
    baseline.description = body;
  }

  return { baseline, errors: [] };
}

/**
 * Minimal YAML frontmatter parser.
 * Handles: strings, arrays (- item), nested objects (one level).
 * For production: replace with a proper YAML parser dependency.
 */
function parseFrontmatter(raw) {
  try {
    return { data: parseWithObjects(raw), error: null };
  } catch (err) {
    return { data: null, error: `Frontmatter parse error: ${err.message}` };
  }
}

function parseWithObjects(raw) {
  const data = {};
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const kvMatch = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value) {
      data[key] = value;
      i++;
    } else {
      // Look ahead: array or object?
      const items = [];
      const obj = {};
      let isArray = false;
      let isObject = false;
      i++;

      while (i < lines.length && lines[i].match(/^\s/)) {
        const arrMatch = lines[i].match(/^\s+-\s+(.+)$/);
        const objMatch = lines[i].match(/^\s+(\w[\w_]*):\s+(.+)$/);

        if (arrMatch) {
          isArray = true;
          items.push(arrMatch[1].trim());
        } else if (objMatch) {
          isObject = true;
          obj[objMatch[1]] = objMatch[2].trim();
        }
        i++;
      }

      if (isArray) data[key] = items;
      else if (isObject) data[key] = obj;
      else data[key] = [];
    }
  }

  return data;
}
