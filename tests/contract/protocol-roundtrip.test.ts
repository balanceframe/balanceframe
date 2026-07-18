import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalProtocolSnapshotSchema,
  canonicalTransactionSchema,
  ruleSchema,
  scheduleSchema,
  budgetMonthSchema,
  tagSchema,
} from "@balanceframe/protocol-generated/validators";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../protocol/fixtures/representative.json",
);
const DATA_QUALITY_FIXTURE_PATH = path.resolve(
  __dirname,
  "../../protocol/fixtures/data-quality.json",
);
const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../protocol/json-schema/protocol-v1.json",
);

function loadFixture(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function minimalSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    actualVersion: "25.1.0",
    snapshotDate: "2026-07-15T00:00:00Z",
    accounts: [],
    transactions: [],
    categories: [],
    payees: [],
    rules: [],
    schedules: [],
    budgets: [],
    tags: [],
  };
}

describe("Canonical normalized protocol round trip", () => {
  it("validates the representative fixture through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);

    expect(validate(loadFixture()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates the shared fixture and every transaction through TypeScript", () => {
    const snapshot = canonicalProtocolSnapshotSchema.parse(loadFixture());

    for (const transaction of snapshot.transactions) {
      expect(canonicalTransactionSchema.safeParse(transaction).success).toBe(true);
    }
  });

  it("validates the edge-case data-quality fixture", () => {
    const fixture = JSON.parse(
      fs.readFileSync(DATA_QUALITY_FIXTURE_PATH, "utf-8"),
    ) as unknown;
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = new Ajv({ strict: false }).compile(schema);

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(canonicalProtocolSnapshotSchema.safeParse(fixture).success).toBe(true);
  });

  it("has a deterministic canonical hash", () => {
    const snapshotA = canonicalProtocolSnapshotSchema.parse(loadFixture());
    const snapshotB = canonicalProtocolSnapshotSchema.parse(loadFixture());
    const digest = (snapshot: unknown) =>
      createHash("sha256")
        .update(canonicalStringify(snapshot), "utf-8")
        .digest("hex");

    expect(digest(snapshotA)).toBe(digest(snapshotB));
  });
});

// ---------------------------------------------------------------------------
// Collection item schema enforcement
// ---------------------------------------------------------------------------

describe("collection item schema enforcement", () => {
  const validRule = {
    id: "rule-1",
    name: "Test Rule",
    order: 1,
    trigger: {},
    actions: {},
    inactive: false,
  };
  const validSchedule = {
    id: "sched-1",
    frequency: "monthly",
    amount: { minorUnits: "10000", currency: "USD" },
    payeeName: "Test Payee",
    accountId: "acc-1",
    nextExpected: "2026-08-01",
  };
  const validBudgetMonth = {
    id: "budget-1",
    month: "2026-07",
    categories: {
      "cat-1": {
        categoryId: "cat-1",
        amount: { minorUnits: "50000", currency: "USD" },
        carryover: { minorUnits: "0", currency: "USD" },
        carryoverFromPrevious: { minorUnits: "0", currency: "USD" },
        carriesOver: true,
      },
    },
  };
  const validTag = { id: "tag-1", name: "Important" };

  // --- JSON Schema boundary tests -------------------------------------------

  it("accepts rules with valid items through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), rules: [validRule] };
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects rules containing [{}] through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), rules: [{}] };
    expect(validate(payload)).toBe(false);
  });

  it("accepts schedules with valid items through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), schedules: [validSchedule] };
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects schedules containing [{}] through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), schedules: [{}] };
    expect(validate(payload)).toBe(false);
  });

  it("accepts budget months with valid items through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), budgets: [validBudgetMonth] };
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects budgets containing [{}] through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), budgets: [{}] };
    expect(validate(payload)).toBe(false);
  });

  it("accepts tags with valid items through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), tags: [validTag] };
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects tags containing [{}] through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = { ...minimalSnapshot(), tags: [{}] };
    expect(validate(payload)).toBe(false);
  });

  it("rejects a rule missing required field 'id' through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = {
      ...minimalSnapshot(),
      rules: [{ name: "no-id", order: 1, trigger: {}, actions: {}, inactive: false }],
    };
    expect(validate(payload)).toBe(false);
  });

  it("rejects a schedule missing required 'amount' through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = {
      ...minimalSnapshot(),
      schedules: [{ id: "s-1", frequency: "monthly", payeeName: null, accountId: "a-1", nextExpected: "2026-08-01" }],
    };
    expect(validate(payload)).toBe(false);
  });

  it("rejects a budget month with invalid month pattern through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = {
      ...minimalSnapshot(),
      budgets: [{ id: "b-1", month: "bad-format", categories: {} }],
    };
    expect(validate(payload)).toBe(false);
  });

  it("rejects a tag missing required 'name' through JSON Schema", () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    const validate = ajv.compile(schema);
    const payload = {
      ...minimalSnapshot(),
      tags: [{ id: "orphan-tag" }],
    };
    expect(validate(payload)).toBe(false);
  });

  // --- Zod schema boundary tests --------------------------------------------

  it("accepts a valid rule item through Zod", () => {
    expect(ruleSchema.safeParse(validRule).success).toBe(true);
  });

  it("rejects an empty rule object through Zod", () => {
    expect(ruleSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a rule missing 'name' through Zod", () => {
    const result = ruleSchema.safeParse({ id: "r-1", order: 1, trigger: {}, actions: {}, inactive: false });
    expect(result.success).toBe(false);
  });

  it("accepts a valid schedule item through Zod", () => {
    expect(scheduleSchema.safeParse(validSchedule).success).toBe(true);
  });

  it("rejects an empty schedule object through Zod", () => {
    expect(scheduleSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a schedule with malformed Money through Zod", () => {
    const result = scheduleSchema.safeParse({
      id: "s-1",
      frequency: "monthly",
      amount: { minorUnits: "not-a-number", currency: "USD" },
      payeeName: null,
      accountId: "a-1",
      nextExpected: "2026-08-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid budget month through Zod", () => {
    expect(budgetMonthSchema.safeParse(validBudgetMonth).success).toBe(true);
  });

  it("rejects an empty budget month object through Zod", () => {
    expect(budgetMonthSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a budget month with invalid month pattern through Zod", () => {
    const result = budgetMonthSchema.safeParse({ id: "b-1", month: "bad", categories: {} });
    expect(result.success).toBe(false);
  });

  it("accepts a valid tag item through Zod", () => {
    expect(tagSchema.safeParse(validTag).success).toBe(true);
  });

  it("rejects an empty tag object through Zod", () => {
    expect(tagSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a tag missing 'name' through Zod", () => {
    expect(tagSchema.safeParse({ id: "t-1" }).success).toBe(false);
  });

  it("rejects a tag with non-string 'id' through Zod", () => {
    expect(tagSchema.safeParse({ id: 42, name: "numeric" }).success).toBe(false);
  });
});
