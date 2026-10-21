import Ajv from 'ajv';
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { registerProtocolSchemas } from './src/schema-registry.js';

it('resolves every protocol root and definition using only registered local schemas', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  registerProtocolSchemas(ajv);
  const directory = new URL('../../protocol/json-schema/', import.meta.url);
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const schema = JSON.parse(fs.readFileSync(new URL(file, directory), 'utf8')) as {
      $id: string;
      $defs?: Record<string, unknown>;
    };
    expect(ajv.getSchema(schema.$id), file).toBeTypeOf('function');
    for (const name of Object.keys(schema.$defs ?? {})) {
      expect(ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }), `${file}: ${name}`).toBeTypeOf(
        'function',
      );
    }
  }
  expect(() => ajv.compile({ $ref: 'https://unregistered.invalid/schema.json' })).toThrow(
    /can't resolve reference/,
  );
});
