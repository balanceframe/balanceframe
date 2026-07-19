# Agent Guidelines

## Git Commits

**Every commit created by an agent MUST include a DCO sign-off.** Agents MUST
invoke `git commit --signoff` (or `git commit -s`) for every commit they
create. This requirement applies even when the user does not mention DCO,
sign-off, or commit options. An unsigned commit is not an acceptable
deliverable.

Before committing, agents MUST read the repository's configured identity and
use those values for Git's generated `Signed-off-by` trailer:

```bash
git config user.name
git config user.email
git commit --signoff
```

Do NOT manually invent, hardcode, or substitute an identity. If either value
is missing or uncertain, run:

```bash
git config --list --show-origin | grep user
```

and stop before committing if no valid identity is configured. After committing,
agents MUST verify the trailer on the commit they created:

```bash
git log -1 --format='%(trailers:only,unfold)'
```

The commit is complete only when that output contains exactly one valid
`Signed-off-by: Name <email>` trailer matching the configured identity.
## Test Driven Development (TDD)

**All code changes MUST follow Test Driven Development.** The testing cycle is mandatory for every unit of work:

1. **Write the failing test first.** Define the observable behavior, edge cases, and failure modes before any implementation code.
2. **Write just enough code to make the test fail (red).** Not pass — just fail. This proves the test is meaningful.
3. **Write the minimal code to make the test pass (green).** No more, no less. Refactor only after green.
4. **Refactor.** Clean up duplicated code, improve naming, simplify logic — tests must remain green.

This cycle applies to:
- **All new features, modules, and public APIs** — every must have tests before the code ships.
- **All bug fixes** — first write a regression test that reproduces the bug, then fix.
- **All changes to financial calculations** (Money, snapshots, reconciliation, categorization) — double-verified with boundary-value tests (overflow, underflow, zero, null, empty arrays, max values).
- **Integration points** (N-API bindings, JSON Schema → TS → Rust round-trips) — every boundary must have contract tests.

**What NOT to do:** Do not write implementation code first and then "add tests for coverage." Tests drive the design, not validate it after the fact.

### Test Coverage Target

Given this is a financial application, the minimum test coverage target is:

| Layer | Minimum Coverage | Rationale |
|---|---|---|
| `crates/financial-core` | **95%+** | Core financial logic (Money, snapshots, reconciliation) must be exhaustively tested. Every boundary (overflow, currency mismatch, zero, null, empty) must have a test. |
| `crates/core-protocol` | **95%+** | Protocol types and analysis functions are the contract between Rust and TypeScript. Every public function must have contract tests. |
| `crates/node-binding` | **90%+** | Binding layer must test all panic containment paths, malformed input rejection, and round-trip serialization. |
| `protocol-generated` | **90%+** | Validators must be tested against valid, invalid, partial, and edge-case payloads. |
| `tests/contract` | **100%** | Contract tests are the interface guarantee. No contract test may be skipped. |
| `tests/actual-integration` | **90%+** | Integration tests must cover all 7 API proof points with explicit assertions (no vacuous checks). |
| All other code | **80%+** | Application, CLI, web, and infrastructure code must maintain strong coverage. |

**Coverage enforcement:** The CI pipeline MUST fail if coverage drops below these thresholds on any PR. Coverage is measured on the changed files plus the overall workspace average.

### Testing Requirements

- **No skipped tests.** Every `it.skip` or `test.skip` requires a tracked issue before merging.
- **No flaky tests.** Tests must be deterministic. Use fixed timestamps, explicit IDs, and reproducible fixtures. If a test has inherent timing or randomness, mock those boundaries.
- **Fixture-based testing.** Use the canonical fixtures in `protocol/fixtures/` for all integration and contract tests. Never construct test data inline when a fixture exists.
- **Negative testing.** Every public function must have tests for failure paths: invalid JSON, missing fields, overflow, boundary values, and unsupported configurations.

## Code Style

- **Rust:** Follow `rustfmt` + `clippy --deny(warnings)`. Use `#![forbid(unsafe_code)]` in all crates. Checked arithmetic for all money operations.
- **TypeScript:** Use the workspace `tsconfig.json` strict mode. No `any` types. Zod validators for all external data.
- **Commit messages:** Conventional commits style (e.g., `feat:`, `fix:`, `docs:`, `test:`). Scope in parentheses when helpful.

## Documentation

- **Docstrings:** All public Rust items must have doc comments (`///`). Document preconditions, postconditions, and error conditions.
- **Public API:** Every exported function must have a one-line summary describing what it does and any non-obvious side effects.
- **Architecture decisions:** Record ADRs (Architecture Decision Records) in `docs/adr/` for non-trivial design choices.
