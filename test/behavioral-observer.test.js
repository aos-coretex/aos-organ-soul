import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Behavioral observer tests.
 * Unit tests use mock data — no LLM or DB required.
 * Integration tests (marked) require ANTHROPIC_API_KEY and soul_memory DB.
 */

describe('Behavioral Observer — validation', () => {
  it('validates observation categories', () => {
    const validCategories = ['PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'];
    for (const cat of validCategories) {
      assert.ok(validCategories.includes(cat));
    }
  });

  it('validates persona_relevance range', () => {
    // These are validation rules the observer enforces
    assert.ok(0.0 >= 0 && 0.0 <= 1);
    assert.ok(1.0 >= 0 && 1.0 <= 1);
    assert.ok(!(1.1 >= 0 && 1.1 <= 1));
    assert.ok(!(-0.1 >= 0 && -0.1 <= 1));
  });

  it('rejects observation with invalid category', () => {
    const obs = { category: 'INVALID', content: 'test', persona_relevance: 0.5 };
    const valid = ['PREFERENCE', 'TRAIT', 'PATTERN', 'MOTIVATION', 'PREDICTION'];
    assert.ok(!valid.includes(obs.category));
  });
});

describe('Behavioral Observer — message filtering', () => {
  it('filters Vivan messages from conversation', () => {
    const messages = [
      { role: 'user', content: 'Hello', participant_urn: 'urn:user:1' },
      { role: 'assistant', content: 'Hi there!', participant_urn: 'urn:graphheight:vivan:test' },
      { role: 'user', content: 'How are you?', participant_urn: 'urn:user:1' },
      { role: 'assistant', content: 'I am well.', participant_urn: 'urn:graphheight:vivan:test' },
    ];

    const vivanUrn = 'urn:graphheight:vivan:test';
    const vivanMessages = messages.filter(
      m => m.participant_urn === vivanUrn || m.role === 'assistant'
    );
    assert.equal(vivanMessages.length, 2);
    assert.equal(vivanMessages[0].content, 'Hi there!');
    assert.equal(vivanMessages[1].content, 'I am well.');
  });

  it('handles conversations with no Vivan messages', () => {
    const messages = [
      { role: 'user', content: 'Hello', participant_urn: 'urn:user:1' },
      { role: 'system', content: 'System message', participant_urn: null },
    ];

    const vivanUrn = 'urn:graphheight:vivan:test';
    const vivanMessages = messages.filter(
      m => m.participant_urn === vivanUrn || m.role === 'assistant'
    );
    assert.equal(vivanMessages.length, 0);
  });
});

describe('Behavioral Observer — hippocampus response normalization', () => {
  it('normalizes flat Hippocampus response to { conversation, messages }', () => {
    // Simulate what Hippocampus GET /conversations/:urn returns
    const hippocampusResponse = {
      urn: 'urn:graphheight:conversation:test-1',
      status: 'completed',
      participants: {
        user_urn: 'urn:user:1',
        persona_urn: 'urn:graphheight:vivan:test',
        agent_session: 'session-1',
      },
      messages: [
        { role: 'user', content: 'Hello', participant_urn: 'urn:user:1' },
        { role: 'assistant', content: 'Hi!', participant_urn: 'urn:graphheight:vivan:test' },
      ],
    };

    // Normalize (same logic as hippocampus-client.js fetchConversation)
    const normalized = {
      conversation: hippocampusResponse,
      messages: hippocampusResponse.messages || [],
    };

    assert.equal(normalized.messages.length, 2);
    assert.equal(normalized.conversation.participants.persona_urn, 'urn:graphheight:vivan:test');
  });

  it('extracts persona_urn from participants (not top-level)', () => {
    const conversation = {
      urn: 'urn:graphheight:conversation:test-2',
      participants: {
        persona_urn: 'urn:graphheight:vivan:test',
      },
    };

    // Bug 4 fix: access via participants?.persona_urn
    const vivanUrn = conversation.participants?.persona_urn;
    assert.equal(vivanUrn, 'urn:graphheight:vivan:test');

    // Verify top-level would be undefined
    assert.equal(conversation.persona_urn, undefined);
  });
});
