import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  moneySchema,
  accountSchema,
  transactionSchema,
  categoryGroupSchema,
  categorySchema,
  payeeSchema,
  ruleSchema,
  scheduleSchema,
  budgetMonthSchema,
  budgetCategorySchema,
  tagSchema,
  protocolSnapshotSchema,
  analysisRequestSchema,
  analysisOptionsSchema,
  analysisResultSchema,
  findingSchema,
  suggestionSchema,
  mutationPlanSchema,
  postconditionSchema,
  ruleSimulationResultSchema,
  validationResultSchema,
  verificationResultSchema,
} from "@balanceframe/protocol-generated/validators";

// ── Helpers ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../protocol/fixtures/representative.json",
);

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../protocol/json-schema/protocol-v1.json",
);

function loadFixture(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
}

/**
 * Deterministic canonical JSON serialisation:
 *   - keys sorted alphabetically at every nesting level
 *   - no extra whitespace
 */
function canonicalStringify(value: unknown): string {
  function sortKeys(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (typeof obj === "object") {
      const entries = Object.entries(obj as Record<string, unknown>)
        .filter(([_, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)] as const);
      return Object.fromEntries(entries);
    }
    return obj;
  }
  return JSON.stringify(sortKeys(value));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Protocol Round-Trip", () => {
  // ── JSON Schema Validation ──────────────────────────────────────────────

  describe("JSON Schema validation", () => {
    it("validates the representative fixture against the JSON Schema", () => {
      const ajv = new Ajv({ strict: true });
      const schema: Record<string, unknown> = JSON.parse(
        fs.readFileSync(SCHEMA_PATH, "utf-8"),
      );
      const validate = ajv.compile(schema);
      const fixture = loadFixture();

      const valid = validate(fixture);
      expect(valid).toBe(true);
      if (!valid) {
        const err = validate.errors?.[0];
        throw new Error(
          `Schema validation failed: ${err?.instancePath} ${err?.message}`,
        );
      }
    });

    it("rejects a malformed fixture against the JSON Schema", () => {
      const ajv = new Ajv({ strict: true });
      const schema: Record<string, unknown> = JSON.parse(
        fs.readFileSync(SCHEMA_PATH, "utf-8"),
      );
      const validate = ajv.compile(schema);

      const invalid = {
        schema_version: "1",
        // missing actual_version, snapshot_date, and all arrays
      };

      const valid = validate(invalid);
      expect(valid).toBe(false);
      expect(validate.errors!.length).toBeGreaterThan(0);
    });
  });

  // ── TypeScript / Zod Parsing ─────────────────────────────────────────────

  describe("Zod validator parsing", () => {
    it("parses the full fixture snapshot successfully", () => {
      const fixture = loadFixture();
      const result = protocolSnapshotSchema.safeParse(fixture);
      expect(result.success).toBe(true);
    });

    it("parses a Money object", () => {
      const money = { minorUnits: "10000", currency: "USD" };
      expect(moneySchema.safeParse(money).success).toBe(true);
    });

    it("rejects Money with invalid currency", () => {
      const bad = { minorUnits: "10000", currency: "US" };
      expect(moneySchema.safeParse(bad).success).toBe(false);
    });

    it("rejects Money with non-string minorUnits", () => {
      const bad = { minorUnits: 10000, currency: "USD" };
      expect(moneySchema.safeParse(bad).success).toBe(false);
    });

    it("parses an Account successfully", () => {
      const acc = {
        id: "a_1",
        name: "Checking",
        type: "checking" as const,
        on_budget: true,
        closed: false,
        note: "",
        order: 0,
      };
      expect(accountSchema.safeParse(acc).success).toBe(true);
    });

    it("rejects Account with invalid type", () => {
      const bad = {
        id: "a_1",
        name: "Checking",
        type: "invalid_type",
        on_budget: true,
        closed: false,
        note: "",
        order: 0,
      };
      expect(accountSchema.safeParse(bad).success).toBe(false);
    });

    it("parses transactions including sub-transactions", () => {
      const fixture = loadFixture() as Record<string, unknown>;
      const txns = fixture["transactions"] as unknown[];
      for (const txn of txns) {
        const result = transactionSchema.safeParse(txn);
        expect(result.success).toBe(true);
      }
    });

    it("parses the split transaction with sub_txns", () => {
      const fixture = loadFixture() as Record<string, unknown>;
      const txns = fixture["transactions"] as unknown[];
      // Find parent transaction by checking the type field
      const parent = txns.find(
        (t) =>
          t !== null && typeof t === "object" && "type" in t &&
          (t as Record<string, unknown>).type === "parent",
      );
      expect(parent).toBeDefined();
      const subTxnResult = transactionSchema.safeParse(parent);
      expect(subTxnResult.success).toBe(true);
      const parsed = subTxnResult.data!;
      expect(parsed.sub_txns).toHaveLength(2);
    });

    it("parses category groups with nested categories", () => {
      const fixture = loadFixture() as Record<string, unknown>;
      const groups = fixture["categories"] as unknown[];
      for (const group of groups) {
        const result = categoryGroupSchema.safeParse(group);
        expect(result.success).toBe(true);
      }
    });

    it("rejects a deleted category group with invalid type", () => {
      const bad = {
        id: "cg_bad",
        name: "Bad",
        deleted: "true", // should be boolean
        hidden: false,
        is_in_report: true,
        categories: [],
      };
      expect(categoryGroupSchema.safeParse(bad).success).toBe(false);
    });

    it("parses a BudgetMonth successfully", () => {
      const bm = {
        id: "budget_test",
        month: "2026-08",
        categories: {
          cat_1: {
            category_id: "cat_1",
            amount: 50000,
            carryover: 0,
            carryover_from_previous: 1000,
            carries_over: true,
          },
        },
      };
      expect(budgetMonthSchema.safeParse(bm).success).toBe(true);
    });

    it("rejects BudgetMonth with invalid month format", () => {
      const bad = {
        id: "budget_bad",
        month: "2026-08-15",
        categories: {},
      };
      expect(budgetMonthSchema.safeParse(bad).success).toBe(false);
    });

    it("parses a Rule with actions successfully", () => {
      const rule = {
        id: "rule_t",
        name: "Test rule",
        trigger: "payee_is" as const,
        trigger_value: "Some Payee",
        actions: [{ action: "set_category" as const, action_data: "cat_1" }],
        inactive: false,
        mtid: null,
        order: 0,
      };
      expect(ruleSchema.safeParse(rule).success).toBe(true);
    });

    it("rejects Rule with invalid trigger", () => {
      const bad = {
        id: "rule_bad",
        name: "Bad",
        trigger: "invalid_trigger",
        trigger_value: null,
        actions: [],
        inactive: false,
        mtid: null,
        order: 0,
      };
      expect(ruleSchema.safeParse(bad).success).toBe(false);
    });

    it("parses a VerificationResult", () => {
      const vr = { verified: true, reason_codes: [] };
      expect(verificationResultSchema.safeParse(vr).success).toBe(true);
    });

    it("parses a MutationPlan with postconditions", () => {
      const plan = {
        plan_id: "plan_1",
        transaction_id: "txn_1",
        current_category_id: "cat_1",
        proposed_category_id: "cat_2",
        hash: "abc123def456",
        postconditions: [
          { type: "category_exists" as const, category_id: "cat_2" },
        ],
      };
      expect(mutationPlanSchema.safeParse(plan).success).toBe(true);
    });

    it("rejects Postcondition with invalid type", () => {
      const bad = { type: "invalid_type", category_id: "cat_1" };
      expect(postconditionSchema.safeParse(bad).success).toBe(false);
    });

    it("parses an AnalysisRequest with nested snapshot", () => {
      const fixture = loadFixture();
      const request = {
        snapshot: fixture,
        options: {
          include_pending: true,
          include_cleared: true,
          max_results: null,
        },
      };
      const result = analysisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it("rejects invalid AnalysisOptions with negative max_results", () => {
      const bad = {
        include_pending: true,
        include_cleared: false,
        max_results: -1,
      };
      expect(analysisOptionsSchema.safeParse(bad).success).toBe(false);
    });

    it("parses a Suggestion", () => {
      const suggestion = {
        transaction_id: "txn_1",
        proposed_category_id: "cat_2",
        category_name: "Shopping",
        confidence: 0.85,
        reason_codes: ["past_pattern"],
        evidence: ["category_used_3_times_last_month"],
      };
      expect(suggestionSchema.safeParse(suggestion).success).toBe(true);
    });

    it("rejects Suggestion with out-of-range confidence", () => {
      const bad = {
        transaction_id: "txn_1",
        proposed_category_id: "cat_2",
        category_name: "Shopping",
        confidence: 1.5,
        reason_codes: [],
        evidence: [],
      };
      expect(suggestionSchema.safeParse(bad).success).toBe(false);
    });
  });

  // ── Round-Trip Serialization ─────────────────────────────────────────────

  describe("round-trip JSON serialization", () => {
    it("serialises and deserialises the fixture preserving all fields", () => {
      const fixture = loadFixture();
      const parsed = protocolSnapshotSchema.parse(fixture);

      // Round-trip through Zod parse → canonical stringify → re-parse
      const reEncoded = JSON.parse(canonicalStringify(parsed));
      const reParsed = protocolSnapshotSchema.parse(reEncoded);

      // Compare canonical forms
      expect(canonicalStringify(reParsed)).toBe(canonicalStringify(parsed));
    });

    it("preserves numeric precision through round-trip", () => {
      const txn = {
        id: "test_1",
        account_id: "a_1",
        payee_id: null,
        category_id: null,
        payee_name: null,
        name: "Test",
        memo: null,
        cleared: "cleared" as const,
        approved: true,
        flag_color: null,
        amount: -123456789,
        date: "2026-07-17",
        imported_payee: null,
        imported_id: null,
        import_date: null,
        deleted: false,
        type: "regular" as const,
        transfer_id: null,
        sub_txns: [],
      };

      const parsed = transactionSchema.parse(txn);
      expect(parsed.amount).toBe(-123456789);
    });

    it("handles nested sub_txns in round-trip", () => {
      const txn = {
        id: "parent_test",
        account_id: "a_1",
        payee_id: "p_1",
        category_id: null,
        payee_name: null,
        name: "Split",
        memo: null,
        cleared: "cleared" as const,
        approved: true,
        flag_color: null,
        amount: -5000,
        date: "2026-07-17",
        imported_payee: null,
        imported_id: null,
        import_date: null,
        deleted: false,
        type: "parent" as const,
        transfer_id: null,
        sub_txns: [
          {
            id: "sub_1",
            account_id: "a_1",
            payee_id: "p_1",
            category_id: "cat_1",
            payee_name: null,
            name: "Part 1",
            memo: null,
            cleared: "cleared" as const,
            approved: true,
            flag_color: null,
            amount: -3000,
            date: "2026-07-17",
            imported_payee: null,
            imported_id: null,
            import_date: null,
            deleted: false,
            type: "sub" as const,
            transfer_id: null,
            sub_txns: [],
          },
          {
            id: "sub_2",
            account_id: "a_1",
            payee_id: "p_1",
            category_id: "cat_2",
            payee_name: null,
            name: "Part 2",
            memo: null,
            cleared: "cleared" as const,
            approved: true,
            flag_color: null,
            amount: -2000,
            date: "2026-07-17",
            imported_payee: null,
            imported_id: null,
            import_date: null,
            deleted: false,
            type: "sub" as const,
            transfer_id: null,
            sub_txns: [],
          },
        ],
      };

      const parsed = transactionSchema.parse(txn);
      const rt = JSON.parse(canonicalStringify(parsed));
      const reparsed = transactionSchema.parse(rt);
      expect(reparsed.sub_txns).toHaveLength(2);
      expect(reparsed.sub_txns[0].id).toBe("sub_1");
      expect(reparsed.sub_txns[1].id).toBe("sub_2");
    });
  });

  // ── Canonical Hash Stability ──────────────────────────────────────────────

  describe("canonical hash stability", () => {
    it("produces a deterministic SHA-256 hash of the fixture", () => {
      const fixture = loadFixture();
      const parsed = protocolSnapshotSchema.parse(fixture);
      const canonical = canonicalStringify(parsed);
      const hash1 = createHash("sha256")
        .update(canonical, "utf-8")
        .digest("hex");

      // Second pass should produce identical hash
      const canonical2 = canonicalStringify(parsed);
      const hash2 = createHash("sha256")
        .update(canonical2, "utf-8")
        .digest("hex");

      expect(hash2).toBe(hash1);
    });

    it("produces identical hashes across two independent parses of the same JSON", () => {
      const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
      const parsedA = protocolSnapshotSchema.parse(JSON.parse(raw));
      const parsedB = protocolSnapshotSchema.parse(JSON.parse(raw));

      const hashA = createHash("sha256")
        .update(canonicalStringify(parsedA), "utf-8")
        .digest("hex");
      const hashB = createHash("sha256")
        .update(canonicalStringify(parsedB), "utf-8")
        .digest("hex");

      expect(hashB).toBe(hashA);
    });

    it("produces different hashes for different data", () => {
      const fixture = loadFixture();
      const parsed = protocolSnapshotSchema.parse(fixture);

      const canonical = canonicalStringify(parsed);
      const hash1 = createHash("sha256")
        .update(canonical, "utf-8")
        .digest("hex");

      // Modify a field
      const modified = { ...parsed, actual_version: "99.0.0" };
      const modifiedCanonical = canonicalStringify(modified);
      const hash2 = createHash("sha256")
        .update(modifiedCanonical, "utf-8")
        .digest("hex");

      expect(hash2).not.toBe(hash1);
    });
  });
});
