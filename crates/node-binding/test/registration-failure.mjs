import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The coverage runner injects a host registration error through the adjacent
// GDB fixture. The caller must receive an error, not a partial native API.
const require = createRequire(import.meta.url);
assert.throws(() => require('../balanceframe.node'), { code: 'GenericFailure' });
console.log('Native registration failure rejected without exposing partial exports');
