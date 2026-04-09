import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplate } from '../lib/template-parser.js';

describe('Template Parser', () => {
  it('parses a valid template with all fields', () => {
    const content = `---
name: Test Persona
traits:
  - curious
  - analytical
constraints:
  - never discuss politics
voice:
  tone: warm
  style: concise
knowledge_domains:
  - distributed systems
behavioral_boundaries:
  - never impersonate a human
---

A test persona for unit testing. Designed to validate the template parser.`;

    const { baseline, errors } = parseTemplate(content);
    assert.equal(errors.length, 0);
    assert.equal(baseline.name, 'Test Persona');
    assert.deepEqual(baseline.traits, ['curious', 'analytical']);
    assert.deepEqual(baseline.constraints, ['never discuss politics']);
    assert.equal(baseline.voice.tone, 'warm');
    assert.equal(baseline.voice.style, 'concise');
    assert.deepEqual(baseline.knowledge_domains, ['distributed systems']);
    assert.deepEqual(baseline.behavioral_boundaries, ['never impersonate a human']);
    assert.ok(baseline.description.includes('unit testing'));
  });

  it('parses a minimal valid template', () => {
    const content = `---
name: Minimal
traits:
  - helpful
voice:
  tone: neutral
  style: direct
---`;

    const { baseline, errors } = parseTemplate(content);
    assert.equal(errors.length, 0);
    assert.equal(baseline.name, 'Minimal');
    assert.deepEqual(baseline.constraints, []);
    assert.deepEqual(baseline.knowledge_domains, []);
    assert.deepEqual(baseline.behavioral_boundaries, []);
    assert.equal(baseline.description, undefined);
  });

  it('rejects template without frontmatter', () => {
    const { baseline, errors } = parseTemplate('Just some text');
    assert.equal(baseline, null);
    assert.ok(errors[0].includes('No YAML frontmatter'));
  });

  it('rejects template without name', () => {
    const content = `---
traits:
  - helpful
voice:
  tone: neutral
  style: direct
---`;
    const { errors } = parseTemplate(content);
    assert.ok(errors.some(e => e.includes('name')));
  });

  it('rejects template with empty traits', () => {
    const content = `---
name: No Traits
traits:
voice:
  tone: neutral
  style: direct
---`;
    const { errors } = parseTemplate(content);
    assert.ok(errors.some(e => e.includes('traits')));
  });

  it('rejects template without voice', () => {
    const content = `---
name: No Voice
traits:
  - helpful
---`;
    const { errors } = parseTemplate(content);
    assert.ok(errors.some(e => e.includes('voice')));
  });
});
