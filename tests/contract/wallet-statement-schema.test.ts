import { registerProtocolSchemas } from './src/schema-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import { expect, it } from 'vitest';
import {
  WalletStatementProofSchema,
  WalletStatementPreviewSchema,
  TransactionEvidenceResultSchema,
  sourceObservationSchema,
} from '@balanceframe/protocol-generated/validators';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const fixture = read('protocol/fixtures/wallet-statement.json');
const ajv = new Ajv({ strict: false });
registerProtocolSchemas(ajv);
const schema = (name: string) =>
  ajv.compile({ $ref: `https://balanceframe.dev/schemas/wallet-statement-v1.json#/$defs/${name}` });
it('aligns human statement schema and strict Zod boundary', () => {
  const proof = fixture.statementProofs[0];
  expect(schema('WalletStatementProof')(proof)).toBe(true);
  expect(WalletStatementProofSchema.parse(proof)).toEqual(proof);
  for (const change of [
    { authorityKind: 'provider_authenticated' },
    { openingBalance: null, closingBalance: null },
    { reviewedAt: 'today' },
    { extra: true },
    { activityManifest: [{}] },
  ]) {
    expect(schema('WalletStatementProof')({ ...proof, ...change })).toBe(false);
    expect(WalletStatementProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
  }
});
it('derives a native manifest and round-trips current scoped balance anchor proofs', () => {
  const native = createRequire(import.meta.url)('../../crates/node-binding/balanceframe.node') as {
    deriveWalletStatementPreview(input: string): string;
    resolveTransactionEvidence(input: string): string;
  };
  const input = {
    contractVersion: '1',
    evidence: fixture,
    walletId: 'wallet',
    startDate: '2026-10-15',
    endDate: '2026-10-16',
  };
  const preview = JSON.parse(native.deriveWalletStatementPreview(JSON.stringify(input)));
  expect(WalletStatementPreviewSchema.parse(preview)).toEqual(preview);
  expect(schema('WalletStatementPreview')(preview)).toBe(true);
  const request = structuredClone(fixture);
  request.statementProofs[0].activityManifest = preview.activityManifest;
  const result = JSON.parse(native.resolveTransactionEvidence(JSON.stringify(request)));
  expect(TransactionEvidenceResultSchema.parse(result)).toEqual(result);
  const source = ajv.compile({
    $ref: 'https://balanceframe.dev/schemas/financial-snapshot-v1.json#/$defs/SourceObservation',
  });
  for (const proof of result.wallets[0].anchorObservations) {
    expect(source(proof), JSON.stringify(source.errors)).toBe(true);
    expect(sourceObservationSchema.parse(proof)).toEqual(proof);
    expect(source({...proof,observedAt:'2026-10-17T00:00:00.123Z'}),JSON.stringify(source.errors)).toBe(true);
    expect(
      sourceObservationSchema.safeParse({ ...proof, scope: { kind: 'claim', id: 'different' } })
        .success,
    ).toBe(false);
    expect(
      sourceObservationSchema.safeParse({ ...proof, kind: 'economic_event_resolution' }).success,
    ).toBe(false);
    expect(sourceObservationSchema.safeParse({ ...proof, walletBalanceAnchor: null }).success).toBe(
      false,
    );
  }
  expect(() => native.deriveWalletStatementPreview('{')).toThrow();
  expect(() => native.deriveWalletStatementPreview('{}')).toThrow();
  expect(() =>
    native.resolveTransactionEvidence(JSON.stringify({ ...request, statementProofs: null })),
  ).toThrow();
});
