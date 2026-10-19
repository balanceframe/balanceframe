# Codex orchestration and readiness

Follow `AGENTS.md` and Ponytail **Full** by default. Explain any task-local
Ultra escalation first; explicit user choices prevail. Use `gpt-6.1-sol`/`high`
for the lead, implementation and routine review. Ordinary planning stays with
the lead; reserve `gpt-6-astra`/`high` for difficult planning or decisions.
Report when the host cannot select the lead or worker settings.

## Hosted delegation

Use the platform's delegation tool and give each worker its instructions
directly. A named TOML profile is not a registered hosted custom agent.
Each handoff should include:

- Role, bounded task, worktree and starting HEAD.
- File ownership and dependencies on other workers; reviewers remain read-only.
- Explicit model/effort request and required `AGENTS.md`/skill reads.
- Constraints, required validation and the expected completion/blocker report.

Do not rely on an inherited model or a role name to convey these instructions.
Keep at most **two active subagents plus the lead**, checking current workers
before admission. Wait for a worker to finish, or checkpoint and stop it before
replacement. This is coordination policy, not proven host enforcement.
Do not reuse an Astra planning worker for routine implementation or packaging.

A minimal hosted smoke is a read-only handoff that reads this checkout's HEAD,
root version and relevant profile/skill files, then returns those facts and any
blocker. Request one Sol/high and one Astra/high smoke when checking both routes.
Record the requested settings, admission/rejection, worker name, worktree/HEAD,
completion and limitations. Accepted settings and a completed task are evidence
of admission and completion, **not independent backend model attestation**.
Do not infer native profile discovery, cap enforcement or runtime health.

## Local-client profiles

The four `.codex/agents/*.toml` files are preserved for compatible local clients:

| Role | Responsibility | Model and reasoning |
| --- | --- | --- |
| `planning` | Difficult requirements, invariants, gaps and ordered plan | `gpt-6-astra`, `high` |
| `implementation` | Bounded implementation and regression verification | `gpt-6.1-sol`, `high` |
| `correctness_review` | Independent behavior and invariant review | `gpt-6.1-sol`, `high` |
| `complexity_review` | Independent simplicity and scope review | `gpt-6.1-sol`, `high` |

Each declares `name`, `description`, `model`, `model_reasoning_effort` and
`developer_instructions`. Discovery depends on the local client/version; consult
its [subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)
and verify discovery there before relying on native selection. These files do
not register agents in the hosted runtime or change running workers.
The six pinned skills under `.agents/skills` remain directly readable even if
the current host does not list them. Their files and provenance are unchanged.

## Separate readiness evidence

| Check | What it establishes | What it does not establish |
| --- | --- | --- |
| Static configuration/skill files | Required profile fields, TOML parsing, expected routing, readable nonempty skill files | Full skill schema validation, native discovery, model availability or runtime readiness |
| Optional nested CLI diagnostics | The result of that CLI's config/provider/app-server probe under its own home and trust context | Hosted delegation admission or completion |
| Hosted delegation smoke | Explicit request admission and read-only task completion, or its actual failure | Independent backend model identity, native registration or enforced concurrency |
| Application/device runtime | The application or device behavior actually exercised | Agent discovery or delegation readiness |

Run the static check and its focused tests with the existing Python 3.11+ tooling:

```bash
python3 .codex/check_config.py
python3 -B -m unittest discover -s .codex -p 'test_check_config.py' -v
```

The checker only reads repository files and exits nonzero on a real validation
error. It does not start Codex, app-server, model calls or application services,
and it neither reads nor writes `CODEX_HOME`. Its success means static checks
passed, not overall hosted readiness. Perform hosted smoke tests separately.

Nested CLI startup is **not mandatory for hosted readiness**. In particular,
Flutter's `inspect-codex.py` launches a nested `codex app-server`; it is not a
BalanceFrame validator. A read-only managed `CODEX_HOME` or project-trust failure
in that probe is a real nested diagnostic failure. Preserve its command, exit
status and error; do not relabel it as success or use it to declare working
hosted delegation broken. Earlier BalanceFrame CLI probes recorded config-load
and six-skill-list evidence, plus managed-home/provider limits; native local
profile discovery/spawning was not established by those observations.

Do not replace `CODEX_HOME`, set `BASH_ENV`, grant hook/project trust, change
security/network/credentials/billing settings, or weaken an application validator
to make a readiness report green. State missing evidence as unverified.

## Saved Cloud environment publication

Repository edits and local smoke results do **not** update a saved Cloud
environment's settings or prove that a future task loads them. After the local
change is reviewed, repository publication requires the separately authorized
push/PR/merge workflow. Then refresh the saved environment's checkout through
the supported platform workflow and run static validation and a fresh hosted
smoke in the actual saved configuration. If a saved setup script copies old
guidance, inspect and review that script separately before changing it.

Record the saved environment/revision and which publication steps actually
completed. No saved-settings change is implied by these files. This repository
does not supply a settings-publication API or require a nested CLI probe.
