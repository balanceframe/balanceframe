/**
 * Content redaction for external inference calls.
 *
 * Prompt-injection text in transaction descriptions, notes, merchant names,
 * and imported payees is redacted before being sent to an external provider.
 * Benign content passes through unchanged. Local provider calls also pass
 * through unchanged.
 */
import type { UnresolvedCandidate, Redactor } from './types';

// ---------------------------------------------------------------------------
// Prompt-injection detection
// ---------------------------------------------------------------------------

/** Regex patterns that indicate prompt-injection attempts. */
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|commands?|context|messages?)\b/i,
  /\byou\s+are\s+not\s+required\s+to\s+follow\b/i,
  /\bsystem:\s*(override|ignore|new instructions?|prompt)\b/i,
  /\bforget\s+(all\s+)?(previous|prior)\s+(instructions?|rules?|commands?|context)\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|commands?|context|messages?)\b/i,
  /\bdo\s+not\s+follow\s+(the\s+)?(instructions?|rules?|guidelines?|prompts?)\b/i,
];

/** Fields whose content is checked for injection patterns. */
const TEXT_FIELDS: Array<keyof Pick<UnresolvedCandidate, 'description' | 'notes' | 'rawMerchant' | 'normalizedMerchant' | 'importedPayee'>> = [
  'description',
  'notes',
  'rawMerchant',
  'normalizedMerchant',
  'importedPayee',
];

function hasInjection(candidate: UnresolvedCandidate): boolean {
  return TEXT_FIELDS.some((field) => {
    const value = candidate[field];
    if (value === null) return false;
    return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
  });
}

// ---------------------------------------------------------------------------
// Redactor factory
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

/** Fields redacted for external calls. */
const SENSITIVE_TEXT_FIELDS: Array<keyof Pick<UnresolvedCandidate, 'description' | 'notes' | 'rawMerchant' | 'normalizedMerchant' | 'importedPayee'>> = [
  'description',
  'notes',
  'rawMerchant',
  'normalizedMerchant',
  'importedPayee',
];

function redactSensitive(input: UnresolvedCandidate): UnresolvedCandidate {
  const out = { ...input };
  for (const field of SENSITIVE_TEXT_FIELDS) {
    if (out[field] !== null) {
      out[field] = REDACTED;
    }
  }
  return out;
}

/**
 * Create a Redactor that redacts sensitive and injection-containing content
 * for external calls while preserving all data for local calls.
 */
export function createRedactor(): Redactor {
  return {
    forExternal(candidate: UnresolvedCandidate): UnresolvedCandidate {
      if (hasInjection(candidate)) {
        return redactSensitive(candidate);
      }
      return { ...candidate };
    },

    forLocal(candidate: UnresolvedCandidate): UnresolvedCandidate {
      // Local calls pass through with no redaction
      return { ...candidate };
    },
  };
}
