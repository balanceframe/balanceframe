import type Ajv from 'ajv';
import type { AnySchemaObject } from 'ajv';
import fs from 'node:fs';

/** Register the complete local protocol schema closure without remote resolution. */
export function registerProtocolSchemas(ajv: Ajv): void {
  const directory = new URL('../../../protocol/json-schema/', import.meta.url);
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const schema = JSON.parse(fs.readFileSync(new URL(file, directory), 'utf8')) as AnySchemaObject;
    ajv.addSchema(schema);
  }
}
