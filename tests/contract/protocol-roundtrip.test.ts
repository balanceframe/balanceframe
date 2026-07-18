import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalProtocolSnapshotSchema,
  canonicalTransactionSchema,
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
