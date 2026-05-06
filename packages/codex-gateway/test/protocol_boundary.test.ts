import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessCodexGatewayProtocolBoundary,
  type CodexGatewayTargetProtocol,
} from '../src/index.js';

test('protocol boundary keeps OpenAI-compatible Chat on the direct adapter path', () => {
  const decision = assessCodexGatewayProtocolBoundary('openai-chat-compatible');

  assert.equal(decision.directAdapterSupported, true);
  assert.equal(decision.requiresIntermediateRepresentation, false);
  assert.equal(decision.strategy, 'responses-to-chat-direct');
  assert.equal(decision.reasons.some((reason) => reason.includes('active production path')), true);
});

test('protocol boundary marks Anthropic and Google native protocols as future IR work', () => {
  for (const target of ['anthropic-messages', 'google-genai'] as CodexGatewayTargetProtocol[]) {
    const decision = assessCodexGatewayProtocolBoundary(target);
    assert.equal(decision.directAdapterSupported, false);
    assert.equal(decision.requiresIntermediateRepresentation, true);
    assert.equal(decision.strategy, 'future-ir-required');
    assert.equal(decision.reasons.length > 0, true);
  }
});

test('protocol boundary treats unknown native protocols as IR-gated by default', () => {
  const decision = assessCodexGatewayProtocolBoundary('unknown-native');

  assert.equal(decision.directAdapterSupported, false);
  assert.equal(decision.requiresIntermediateRepresentation, true);
  assert.equal(decision.strategy, 'future-ir-required');
  assert.equal(decision.reasons[0].includes('Unknown native protocols'), true);
});
