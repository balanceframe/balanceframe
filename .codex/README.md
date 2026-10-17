# Repository-local Codex roles

These standalone `.codex/agents/*.toml` profiles follow the current [Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents). Each declares `name`, `description`, and `developer_instructions`. No `.codex/config.toml` registration is required by this schema.

| Role | Responsibility | Model and reasoning |
| --- | --- | --- |
| `planning` | Requirements, gaps, invariants, and dependency-ordered plan | `gpt-6-astra`, `high` |
| `implementation` | Bounded implementation and regression verification | Inherit from parent/default configuration |
| `correctness_review` | Independent behavior and invariant review | Inherit from parent/default configuration |
| `complexity_review` | Independent simplicity and scope review | Inherit from parent/default configuration |

Use a fresh local Codex client from this repository to discover project roles and the six skills under `.agents/skills`. Follow `AGENTS.md` for Ponytail Full by default, task-local escalation, and explicit user preferences. Profiles do not configure sandbox policy, approvals, hook trust, or network access. Hook trust remains a separate user-controlled decision.

## Validation and environment limits

Validated against the official schema with Codex CLI `0.159.2`: all four files parse as TOML, contain the required fields, and omit model/effort overrides except for planning. `codex --strict-config doctor --json` reported `config.load: ok`; this is configuration-load evidence, not proof that roles were discovered or spawned. The overall doctor check failed on provider reachability.

The first sandboxed `codex app-server` attempt could not initialize SQLite state under the active read-only `/run/codex-environment/codex-home`. An approved retry permitting routine runtime initialization succeeded without changing the active home or security settings. Only `initialize`, `config/read`, and `skills/list` were requested; no threads, model runs, or hooks were started. Native `skills/list` confirmed all six repository-local `.agents/skills/*/SKILL.md` paths.

`config/read` returned the existing global legacy role registrations, so that response does not prove discovery or native parsing of these repository-local standalone profiles. Their TOML structure was checked independently; native local-role discovery and spawning remain unverified. Verify the local profiles in a fresh client before relying on native role selection.

The hosted collaboration harness used explicit named role handoffs. Its ability to select these custom native profiles is unverified; installing files does not retroactively activate them in an existing hosted session. Planning's prescribed model/effort must be selected explicitly when that harness supports it; report unsupported selections rather than claiming native activation.
