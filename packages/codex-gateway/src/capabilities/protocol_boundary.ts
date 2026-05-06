export type CodexGatewayTargetProtocol =
  | 'openai-chat-compatible'
  | 'anthropic-messages'
  | 'google-genai'
  | 'unknown-native';

export interface CodexGatewayProtocolBoundaryDecision {
  targetProtocol: CodexGatewayTargetProtocol;
  directAdapterSupported: boolean;
  requiresIntermediateRepresentation: boolean;
  strategy: 'responses-to-chat-direct' | 'future-ir-required';
  reasons: string[];
}

export function assessCodexGatewayProtocolBoundary(
  targetProtocol: CodexGatewayTargetProtocol,
): CodexGatewayProtocolBoundaryDecision {
  switch (targetProtocol) {
    case 'openai-chat-compatible':
      return {
        targetProtocol,
        directAdapterSupported: true,
        requiresIntermediateRepresentation: false,
        strategy: 'responses-to-chat-direct',
        reasons: [
          'OpenAI-compatible Chat providers preserve the active production path.',
          'Current Codex Gateway capability, payload, SSE, and tool-call rules already target this family.',
        ],
      };
    case 'anthropic-messages':
      return {
        targetProtocol,
        directAdapterSupported: false,
        requiresIntermediateRepresentation: true,
        strategy: 'future-ir-required',
        reasons: [
          'Anthropic uses a native Messages protocol with a separate system field and required max_tokens semantics.',
          'Tool choice, thinking, and response-format behavior diverge enough that a direct Responses-to-Chat shim is no longer the right abstraction.',
        ],
      };
    case 'google-genai':
      return {
        targetProtocol,
        directAdapterSupported: false,
        requiresIntermediateRepresentation: true,
        strategy: 'future-ir-required',
        reasons: [
          'Google GenAI uses native content parts, candidate responses, and provider-specific tool/thought metadata.',
          'Supporting Gemini-native endpoints cleanly requires a shared intermediate representation instead of extending the Chat-compatible shim further.',
        ],
      };
    case 'unknown-native':
    default:
      return {
        targetProtocol,
        directAdapterSupported: false,
        requiresIntermediateRepresentation: true,
        strategy: 'future-ir-required',
        reasons: [
          'Unknown native protocols should not be forced through the current Responses-to-Chat adapter without an explicit IR boundary review.',
        ],
      };
  }
}
