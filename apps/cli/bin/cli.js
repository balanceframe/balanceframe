#!/usr/bin/env node
// Runtime entrypoint for the balanceframe CLI.
// Relies on the compiled output from `pnpm build`.
import { main } from '../dist/index.js';

const result = await main(process.argv.slice(2));
process.stdout.write(result + '\n', () => process.exit(0));
