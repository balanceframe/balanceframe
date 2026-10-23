#!/usr/bin/env node
// Runtime entrypoint for the balanceframe CLI.
// Relies on the compiled output from `pnpm build`.
import { main } from '../dist/index.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const showVersion = args.length === 1 && args[0] === '--version';
const showActionHelp = args[0] === 'proposals' && args[1] === 'action' &&
  args.length === 3 && args[2] === '--help';
const showHelp = args[0] === '--help' && args.length === 1 ||
  args[0] === 'merchant' && args.at(-1) === '--help' &&
  (args.length === 2 || args.length === 3 && ['research', 'space-policy'].includes(args[1]));
const result = showVersion
  ? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  : showActionHelp
  ? `Consequential action proposal (authenticated selected space):
  balanceframe proposals action --action-file ACTION.json --json

ACTION.json is a strict object containing only {\"action\": ..., \"decision\"?: ...}.
The optional decision is either a saved session origin (sessionId and sessionVersion)
or a complete pinned purchase decision. Actor authority, plans, source facts and
Actual credentials are never accepted from this file. Review, approve and execute
remain separate:
  balanceframe proposals show PROPOSAL_ID --json
  balanceframe proposals approve PROPOSAL_ID --payload-hash DISPLAYED_HASH --json
  balanceframe proposals execute PROPOSAL_ID --json.`
  : showHelp ? `Merchant intelligence (authenticated selected space):
  balanceframe merchant analyze --json
  balanceframe merchant research policy --json
  balanceframe merchant research preview --evidence-key KEY --evidence-revision REVISION --merchant 'Public Business Name' --public-business true [--locale US|CA|GB] --json
  balanceframe merchant research send --evidence-key KEY --evidence-revision REVISION --merchant 'Public Business Name' --public-business true [--locale US|CA|GB] --preview-token TOKEN --consent true --idempotency-key ID --json
  balanceframe merchant research cache --evidence-key KEY --evidence-revision REVISION --merchant 'Public Business Name' --public-business true [--locale US|CA|GB] --json
  balanceframe merchant space-policy get --json
  balanceframe merchant space-policy set --expected-version VERSION --policy 'COMPLETE_SPACE_POLICY_JSON' --json

Enter public-business text manually; never prefill or extract bank/import/payee/notes text.
Preview sends nothing to the provider. Review exact fields, provider, disclosure, expiry,
billing currency and cost atoms before a separate consented send. No automatic retry.
1,000,000 atoms = one billing minor unit. Pending/uncertain outcomes may retain charges.
Space-policy replacement requires a fresh human session, its own optimistic version,
and a complete policy without calendars. Installation/provider/credential settings
are server-owned; delegated research still requires current research/source grants.
Sources are historical untrusted observations with uncalibrated confidence, not
financial category, identity, approval or execution proof. See apps/cli/README.md.` : await main(args);
process.stdout.write(result + '\n', () => process.exit(0));
