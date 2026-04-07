import type { Message } from "../shared";
import type { PrivacyConfig, PiiEntityType } from "../shared";

// ---------------------------------------------------------------------------
// PII detection and redaction engine.
// Pattern-based only. No ML or external calls.
// Runtime safeguard, not a compliance-grade detector. May miss edge cases.
// ---------------------------------------------------------------------------

// Return a fresh RegExp each time.
// Global regexes keep lastIndex, so shared instances break repeated calls.
const PATTERN_FACTORIES: Readonly<Record<PiiEntityType, () => RegExp>> = {
  // RFC 5322-adjacent: covers common address formats, not obfuscated variants.
  email: () => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,

  // US-format numbers with explicit separators. Avoids matching bare digit sequences.
  // Uses (?<!\d) instead of \b — \b fails before '(' so (555) 867-5309 would be missed.
  phone: () =>
    /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?\d{3}|\d{3}[\s.-]\d{3})[\s.-]\d{4}\b/g,

  // Dashed SSN format only (NNN-NN-NNNN). Bare 9-digit strings are excluded.
  ssn: () => /\b\d{3}-\d{2}-\d{4}\b/g,

  // 16 digits in 4-digit groups separated by spaces or dashes.
  credit_card: () => /\b(?:\d{4}[\s-]){3}\d{4}\b/g,

  // Common API key and token patterns: OpenAI, Anthropic, GitHub, GitLab, Slack, Bearer.
  // Bearer minimum is 40 chars — real tokens (JWTs, OAuth) are well above this threshold;
  // shorter values are likely prose or placeholder text, not secrets worth blocking.
  secret: () =>
    /\b(?:sk-|sk_|pk-|pk_)[A-Za-z0-9_-]{20,}\b|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|xox[bpoa]-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9+/=_.-]{40,}/gi,

  // Standard dotted-decimal IPv4. Validates each octet range.
  ipv4: () =>
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
};

const PLACEHOLDERS: Readonly<Record<PiiEntityType, string>> = {
  email: "[REDACTED_EMAIL]",
  phone: "[REDACTED_PHONE]",
  ssn: "[REDACTED_SSN]",
  credit_card: "[REDACTED_CARD]",
  secret: "[REDACTED_SECRET]",
  ipv4: "[REDACTED_IPV4]",
};

const ALL_ENTITIES: readonly PiiEntityType[] = [
  "email",
  "phone",
  "ssn",
  "credit_card",
  "secret",
  "ipv4",
];

export interface PrivacyCheckResult {
  /** Total number of PII matches across all messages. */
  readonly totalMatches: number;
  /** Deduplicated list of detected entity categories. Never contains raw values. */
  readonly categories: readonly PiiEntityType[];
  /**
   * Messages with PII replaced by placeholders.
   * Identical to input when totalMatches === 0 or mode is not "redact".
   */
  readonly redactedMessages: readonly Message[];
}

/**
 * Scan messages for PII and produce redacted copies.
 * Redacted messages are always computed so the caller doesn't need to branch.
 */
export function checkPrivacy(
  messages: readonly Message[],
  config: PrivacyConfig,
): PrivacyCheckResult {
  const entities = config.entities ?? ALL_ENTITIES;
  const matchCounts = new Map<PiiEntityType, number>();

  const redactedMessages = messages.map((msg): Message => {
    let content = msg.content;
    let changed = false;

    for (const entity of entities) {
      const pattern = PATTERN_FACTORIES[entity]();
      const matches = content.match(pattern);
      if (matches) {
        matchCounts.set(entity, (matchCounts.get(entity) ?? 0) + matches.length);
        content = content.replace(pattern, PLACEHOLDERS[entity]);
        changed = true;
      }
    }

    return changed ? { ...msg, content } : msg;
  });

  const categories = [...matchCounts.keys()];
  const totalMatches = [...matchCounts.values()].reduce((sum, n) => sum + n, 0);

  return { totalMatches, categories, redactedMessages };
}
