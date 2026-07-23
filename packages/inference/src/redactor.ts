/**
 * Content redaction for external inference calls.
 *
 * Prompt-injection text in transaction descriptions, notes, merchant names,
 * and imported payees is redacted before being sent to an external provider.
 * Benign content passes through unchanged. Local provider calls also pass
 * through unchanged.
 *
 * Hardening:
 * - Unicode/format-control character obfuscation detection
 * - Direct instruction override patterns
 * - Field-wide leak prevention: if ANY sensitive field contains injection,
 *   ALL sensitive fields are redacted to prevent side-channel leaks
 * - Benign false-positive avoidance
 */
import type { UnresolvedCandidate, Redactor } from './types';

// ---------------------------------------------------------------------------
// Format-control / obfuscation Unicode ranges
// ---------------------------------------------------------------------------

/** Regex matching Unicode format-control and obfuscation characters. */
const FORMAT_CONTROL_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

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

/**
 * Check if a single text value contains injection or obfuscation patterns.
 */
function textHasInjection(value: string): boolean {
  // Check for Unicode format-control obfuscation
  if (FORMAT_CONTROL_PATTERN.test(value)) {
    return true;
  }
  // Strip format-control characters for injection pattern testing
  const cleaned = value.replace(FORMAT_CONTROL_PATTERN, '');
  return INJECTION_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function hasInjection(candidate: UnresolvedCandidate): boolean {
  return TEXT_FIELDS.some((field) => {
    const value = candidate[field];
    if (value === null) return false;
    return textHasInjection(value);
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
 * Create a Redactor that always applies privacy redaction for external calls
 * and additionally detects injection patterns.
 *
 * Privacy redaction is ALWAYS applied to sensitive text fields for external calls,
 * independent of injection detection. This ensures PII/PCI data never reaches
 * external providers.
 *
 * Injection detection is an additional safeguard: if ANY sensitive field contains
 * injection patterns, it can be checked via hasInjection(). The orchestrator may
 * use this for logging or telemetry, but privacy redaction already protects
 * the data.
 */
export function createRedactor(): Redactor {
  return {
    forExternal(candidate: UnresolvedCandidate): UnresolvedCandidate {
      // Privacy redaction is always applied — independent of injection.
      // This ensures sensitive fields never reach external providers.
      return redactSensitive(candidate);
    },

    forLocal(candidate: UnresolvedCandidate): UnresolvedCandidate {
      // Local calls pass through with no redaction.
      return { ...candidate };
    },

    /** Check whether the candidate contains injection patterns. */
    hasInjection(candidate: UnresolvedCandidate): boolean {
      return hasInjection(candidate);
    },
  };
}
