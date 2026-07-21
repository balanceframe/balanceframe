# BalanceFrame roadmap

> **Status:** Planning complete; implementation has not started.
>
> **Canonical name and domain:** **BalanceFrame** — <https://balanceframe.com>
>
> **License:** Apache-2.0. **Initial ledger backend:** Actual Budget.

BalanceFrame is an open-source, self-hostable intelligence and workflow layer for household finance. It begins by reducing the Actual Budget transaction-categorization backlog. It must make an existing budget progressively less laborious without taking ownership away from its users or trapping their data.

## Product promise

> **The project tells users what needs attention, proves why, helps them resolve it quickly, and learns how not to ask again—without hiding uncertainty or taking control away from them.**

This promise governs prioritization. A feature that produces more financial data but does not improve trust, actionability, or declining maintenance is not automatically valuable.

## Ruthless product priority order

When requirements compete, use this order:

1. Trustworthy synchronization, freshness, and reconciliation.
2. Excellent transaction-review user experience.
3. Progressive conversion from model suggestions to deterministic Actual rules.
4. First-class manual entry and imported-transaction reconciliation.
5. Clear separation of ledger facts, envelope availability, forecasts, advice, authorization, and execution.
6. Useful read-only onboarding before asking for write access.
7. Inspectable, reversible, user-owned automation.
8. Independent identities and selectively scoped collaboration.
9. Full usefulness without AI or cloud providers.
10. Exportability, removability, and low maintenance.

This ordering is intentional. A polished model-generated recommendation built on stale or duplicated data has negative value. A broad platform that fails to reduce categorization work has not earned its later scope.

## Largest product risks

The highest risks, in order, are:

1. Advice based on stale, incomplete, duplicated, or misclassified data.
2. Creating another workload instead of removing one.
3. Letting the model become a financial or authorization authority.
4. Opaque rules and silent learned behavior.
5. A review queue that never shrinks.
6. All-or-nothing collaboration or shared credentials.
7. Conflicting numbers across ledger, budget, report, and forecast views.
8. Platform, ledger, bank-aggregator, or model-provider lock-in.
9. Monetization that conflicts with user outcomes.
10. Building the end-state platform before proving the categorization MVP.

Every phase exit criterion and product review should explicitly consider these risks.

## Product contract

- **Actual owns ledger and budgeting facts.** BalanceFrame owns spaces, identity, authorization, policy, workflow, provenance, approvals, intelligence orchestration, and eventually linked-space coordination.
- **Deterministic code is authoritative.** Rust performs financial validation, checked money calculations, data-quality gates, mutation planning, and postcondition verification. TypeScript owns Actual integration, workflow/state, providers, UI, CLI, and orchestration.
- **Models are untrusted semantic helpers.** They may interpret, explain, research, and submit schema-validated typed requests. They never determine identity, authorization, current-data sufficiency, final money arithmetic, transaction identity, mutation validity, or approval sufficiency.
- **Actual remains independently usable.** BalanceFrame must be removable: a failure, disconnect, restore, or uninstall never corrupts Actual or makes the user's budget inaccessible.
- **Deletion is deliberate and verifiable.** BalanceFrame must support export-first, policy-aware deletion of its own metadata and credentials without altering Actual. Disconnect, scoped data deletion, and complete application removal are distinct lifecycle operations; retained audit or shared-record data must be disclosed with its retention reason.
- **Local/no-model operation is first class.** Users can choose per-capability locality and provider policy. Disabling every model provider preserves synchronization, health diagnostics, manual review, Actual rules, reconciliation, reports, exports, spaces, authorization, and deterministic analysis where data is sufficient.
- **Financial states stay distinct.** Ledger facts, envelope availability, cash-flow projections, advice, proposals, and confirmed execution results are separate types and visibly labelled views.
- **Maintenance is a release constraint.** The initial self-hosted product is a modular monolith: one application container, one project data volume, optional local model, and Actual either user-supplied or separate. No broker, Kubernetes, fork, Git submodule, microservice fleet, or Rust daemon.
- **Progressive determinism is the goal.** The model resolves new ambiguity, not repeatedly solved cases. The desired lifecycle is: new ambiguity → model suggestion → human approval or correction → repeated consistent outcome → deterministic rule proposal → historical simulation → explicit approval → Actual rule → future imports handled without model inference.

## Terminology

- **Ledger backend:** a system implementing accounts, transactions, categories, balances, budgets, rules, and related primitives. Actual is the first backend.
- **Ledger connection:** configured access from a space to a ledger backend and budget.
- **Space:** the neutral top-level collaboration, policy, and authorization boundary. It can contain one or many people without implying family, marriage, cohabitation, or permanence. User-facing variants include **budget space** (recommended when context is needed), **personal space** (one person's private financial environment), **shared space** (multiple members deliberately coordinating finances), and **linked space** (a shared coordination environment receiving selected projections from separate private spaces). Internally, use `Space`; in product copy, use "budget space" where bare "space" would be ambiguous.
- **Suggestion:** an immutable model-produced candidate interpretation, not a ledger mutation.
- **Review item:** durable workflow state around a suggestion or ambiguity.
- **Proposal:** an exact prospective action with immutable payload, hash, expiry, provenance, and preconditions.
- **Approval:** authorization by an eligible actor for one exact proposal payload.
- **Projection:** deliberately disclosed information published from a private space into a linked space.
- **Policy:** deterministic configuration governing visibility, automation, advice, approvals, mutations, and AI-agent delegation.
- **AI agent:** a model-backed actor with an independently auditable identity and an explicitly delegated, revocable set of operational capabilities. It is not a human identity and cannot alter its own authority.


## What is upcoming next

### Phase 00 — Development environment setup

The first implementation phase to begin is [`mvp/00-development-environment-setup.md`](mvp/00-development-environment-setup.md). It establishes a pinned, modular Nix Flake as the canonical development environment for every later phase. All project tooling — Rust, Node/TypeScript, native-build dependencies, Git, repository scripts — must be available through `nix develop` without depending on ambient system packages. A committed `flake.lock` and root `nix/` modules with documented dev-shell and check outputs are required before any code work begins.

This phase does not renumber the existing implementation phases. It is numbered `00` to make its prerequisite position explicit: Phase 0's Actual/API proof begins only after the toolchain environment is reproducible.

### Phase 0 — Actual baseline and technical proof

Phase 0 proves stock Actual integration and the Rust–TypeScript contract before product workflow implementation. It begins after Phase 00 completes.

The work establishes sanitized fixtures; measures manual categorization; proves every required public `@actual-app/api` operation against representative budgets; tests data-quality blockers, export, disconnect, and Actual-independent operation; and produces tested N-API artifacts for Linux x86-64 and ARM64.

No ledger mutation or product automation should be built before this proof establishes that the public Actual API, synchronized-cache lifecycle, and native binding are viable without a fork.

## What is upcoming

### MVP: prove a diminishing categorization exception inbox

| Phase | Outcome | Exit gate |
|---|---|---|
| [1](mvp/01-read-only-actual-gateway.md) | Read-only Actual gateway and deterministic Rust analysis | CLI lists valid candidates without modifying Actual. |
| [2](mvp/02-suggestion-only-classifier.md) | Provider-neutral, suggestion-only classification | Fixture evaluation produces suggestions but no ledger mutations. |
| [3](mvp/03-review-workflow.md) | Fast, responsive single exception inbox | Review is measured faster or less burdensome than categorizing directly in Actual. This is the primary product-validation gate. |
| [4](mvp/04-approved-categorization-writes.md) | Exact, approved, recoverable category writes | Stale, replayed, conflicting, or unauthorized changes cannot silently alter Actual. |
| [5](mvp/05-deterministic-learning.md) | Inspectable rule learning and historical simulation | Recurring categorization work and model use decline over time. |

Phases 0–5 are the MVP. Do not build the broader platform if Phase 3 does not prove a declining, lower-burden review workflow.

### Post-MVP: open-source product depth

| Phase | Outcome | Exit gate |
|---|---|---|
| [6](post-mvp/06-built-in-conversational-interface.md) | Optional conversational interface, Skill, and Hermes adapter | Chat improves accessibility without inventing facts or bypassing policy. |
| [7](post-mvp/07-space-governance.md) | Spaces, independent identities, scoped capabilities, approvals | Every read and action is attributable and deterministically enforced. |
| [8](post-mvp/08-budget-intelligence.md) | Alerts, recurrence/duplicate evidence, notification delivery, sinking funds, affordability | Scenario tests show conservative analysis under stale or incomplete data and notifications are authorized, redacted, deduplicated, and independently degradable. |
| [9](post-mvp/09-controlled-reallocations.md) | Approval-gated reallocation proposals | Stale proposals cannot double-use funds or violate protected categories. |
| [9.5](post-mvp/09-5-delegated-operational-autonomy.md) | Bounded, revocable AI-agent operational delegation | Revocation precedes the next execution; every delegated mutation is bounded, attributable, replay-safe, and verified. |
| [10](post-mvp/10-linked-spaces.md) | Privacy-preserving cross-instance coordination | Participants coordinate selected expenses without exposing unrelated private ledger data. |

A future custom Rust ledger is not a scheduled phase. It is considered only after pure-core reuse, signed-event work, shadow-mode differential validation against Actual, and an explicit migration decision. A Rust daemon and Rust-owned ledger database are prohibited before then.

### Rust post-MVP expansion path

After the MVP, Rust expands in this order:

1. Add affordability, protected-category, donor, and reallocation policy to Rust.
2. Strengthen deterministic reconciliation and institution-behavior analysis.
3. Compile pure Rust crates to **WebAssembly 3.0** for non-authoritative local previews and offline analysis, after cross-target fixture parity is proven.
4. Add canonical signed linked-space events, verification, and deterministic reducers.
5. Build a Rust custom ledger in shadow mode and compare it with Actual.
6. Adopt a Rust ledger daemon and Rust-owned ledger database only after differential validation and an explicit migration decision.

TypeScript continues to own the product shell throughout these stages. The MVP web shell is **Vue 3 + Nuxt 4** with **Nuxt UI v4**. Nuxt/Nitro is deployed as the Node application server, while authenticated operational routes are client-rendered initially and use narrow application APIs. The framework-neutral web controller remains the source of truth for review state; Wasm is an optional read-only acceleration/reuse target, never a browser authority for authorization or ledger mutation.

## Completed

The following are completed **roadmap and planning decisions**, not implemented product features unless stated otherwise:

- **BalanceFrame** is the selected project name. It combines **balance** (account/budget balance plus sustainable tradeoffs among a household's needs, goals, and spending) and **frame** (a clear, structured view for making deliberate decisions without surrendering control). The name supports trustworthy financial facts, explainable guidance, collaborative decision-making, and a product scope broader than AI categorization. It does not imply affiliation with Actual Budget or dependence on a single ledger backend. The canonical public domain is `balanceframe.com` — domain control establishes the project's web identity but does not establish trademark rights or replace clearance. Formal trademark clearance remains a pre-commercial requirement. The name avoids `AI` in the core name and avoids `Actual` to prevent implying official affiliation and to preserve future ledger independence. Before public commercial branding or material brand investment, complete: trademark database searches in relevant jurisdictions; exact, phonetic, and confusingly similar financial-product collision searches; GitHub organization availability; npm scope/package checks; container registry namespace checks; app-store searches; social-handle checks; common-misspelling checks; and legal review of trademark registration and brand-protection strategy.
- Apache-2.0 is selected. DCO sign-off, protected branches, review/CI, security reporting, dependency/license/secret scanning, third-party notices, build provenance, and a trademark policy are required governance artifacts.
- Actual is the initial, replaceable ledger backend. Integration uses the published `@actual-app/api`; there is no Actual or Actual AI fork, and no internal Actual CLI invocation.
- The MVP is a Rust–TypeScript modular monolith. Rust is embedded by coarse-grained N-API calls and owns the versioned cross-language financial protocol; TypeScript never reimplements Rust-owned calculations.
- Money is checked integer minor units; protocol money is decimal-string minor units plus currency. IDs are opaque strings, timestamps are canonical UTC, all requests carry correlation IDs.
- The MVP has no Rust daemon, Rust-owned database, custom ledger, automatic category/rule creation, model-initiated writes, broad chat, federation, MCP dependency, or hosted-service requirement.
- Model-derived MVP ledger changes always receive `approval_required`. The shared typed-intent/proposal/authorization/mutation pipeline remains ready for later operational delegation without adding an agent-only write path.
- **The web framework and component library are selected:** Vue 3 with Nuxt 4 and Nuxt UI v4. Nuxt is the presentation/runtime shell over the framework-neutral web controller and TypeScript application services; it is not an authorization or financial authority.


## Non-negotiable acceptance criteria

Every phase must preserve these conditions:

1. A user can receive a useful read-only result during initial onboarding.
2. Connection health, snapshot freshness, coverage, inclusion scope, pending policy, duplicate/reconciliation ambiguity, and blockers are primary product information—not hidden settings.
3. Materially stale, missing, duplicated, or ambiguous data blocks affected advice with `insufficient_data`; it never becomes confident output.
4. Manual entry and later import reconciliation are peers. Ambiguous records are concise review items; models never merge transactions.
5. One prioritized attention surface replaces competing categorization, duplicate, alert, and rule inboxes.
6. The review workflow is faster than direct ledger categorization in measured testing.
7. Repeated corrections become deterministic behavior or explicit rule proposals.
8. Automation is inspectable, attributable, historically simulated where applicable, editable, disableable, reversible where possible, exportable, and never authorized by model confidence alone.
9. Envelope availability and cash-flow projection are available but never conflated.
10. Credit-card, transfer, split, reimbursement, pending, and rollover semantics are consistent across views.
11. Reports persist user-selected filters and expose exact inclusion rules.
12. Recurring and subscription findings support correction and dismissal.
13. Responsive web and CLI cover every critical workflow with semantically consistent, versioned results. The maintained Skill is ergonomic guidance, not a security boundary. No core capability is platform-exclusive.
14. Export, backup, restore, disconnect, safe removal, and policy-aware deletion of BalanceFrame-owned data are tested product paths; none may alter Actual ledger records.
15. Collaboration uses separate identities, temporal memberships, deterministic capabilities and scopes—not shared passwords, forwarded magic links, or automatic private-ledger disclosure.
16. AI/model features can be disabled without making core budgeting unusable.
17. The product remains useful when institution sync, model inference, merchant research, or notifications are unavailable independently.
18. Notifications are attributable, recipient-authorized, policy-redacted, idempotent, and independently failure-tolerant.
19. Open-source functionality is not conditioned on advertising, transaction-data sale, a specific bank aggregator, a specific model provider, a specific device platform, or a hosted service.

## Scope

This roadmap defines the complete open-source, self-hosted BalanceFrame product scope and phased implementation sequence. It intentionally excludes paid managed-service delivery work while preserving the open-source product's self-hosting, export, privacy, provider-choice, and non-conflicted-monetization constraints.

## Permanent implementation constraints and evidence backlog

### Architecture and compatibility

- Rust protocol schemas, the N-API binding/toolchain, supported native platform matrix beyond container-first Linux x86-64/ARM64, Actual API/server compatibility policy, and detailed authentication behavior remain explicit evidence-backed choices rather than settled assumptions. The selected product web stack is Vue 3 + Nuxt 4 with Nuxt UI v4.
- Every native call is immutable, coarse-grained, deterministic, independently testable, and versioned. Do not add a Rust crate per module before a stable API/portability boundary appears.
- Design pure Rust modules for later **WebAssembly 3.0** compilation for non-authoritative local previews and offline analysis. Treat browser Wasm as untrusted client computation; it must not authorize, approve, mutate, audit, or verify Actual writes. This is post-MVP work, not an MVP requirement.
- Initial self-hosted deployment target: one Actual container or user-supplied Actual server; one project application container; one project data volume; one Actual data volume when bundled; optional local model container; one configuration source or guided setup; built-in health checks and migrations; no broker, Kubernetes, fork, Git submodule, or microservice fleet.
- Failure independence: Actual remains usable if the project is down; failed inference does not block imports or manual budgeting; a corrupt project metadata store does not corrupt Actual; disconnecting the project does not delete Actual records; project metadata is exportable.
- Backup model: back up separately (1) Actual financial data, (2) project SQLite metadata/approvals/provenance/alert state/shared records, (3) version-controlled configuration, (4) encrypted secrets through a separate secret backup process. Restore tests must verify Actual opens/synchronizes, migrations succeed, ledger references resolve or fail visibly, queued writes do not replay, approvals remain consumed/expired, and CLI/UI can query restored state.
- **Deletion lifecycle:** before deleting BalanceFrame-owned data, provide a scoped inventory and export opportunity; re-authenticate and confirm the exact deletion scope; cancel queued work; revoke affected credentials, sessions, delegations, and notification destinations; remove caches and metadata; and report anything retained with its policy and reason. This never modifies Actual records. Existing encrypted backups follow their documented retention/expiry process and are disclosed rather than silently claimed erased.

### Product lessons carried into implementation

- Ingestion quality comes before advanced intelligence: “connected” never means healthy/current/complete; incident state and last successful sync belong on the primary status surface.
- Preserve Actual/YNAB envelope semantics while offering a separately labeled cash-flow lens, reports, targets, schedules, watchlists, recurring/subscription evidence, and optional net-worth context. Credit-card, transfer, reimbursement, split, pending, and rollover treatment must be consistent and explained.
- Deliver an early, read-only win—such as backlog, stale-connection, duplicate, recurring-charge, or repeated-correction evidence—without large setup. Teach using the user’s actual state rather than generic doctrine.
- Review polish is a functional requirement: fast correction, clear evidence, undo, group only homogeneous cases, durable saved views/filters, and immediate progression matter more than suggestion count or decorative charts.
- Rules must support context and historical simulation; their match, precedence, provenance, and rollback remain visible. Recurrence/subscription detection is evidence with correction/dismissal, never a confident opaque claim.
- Protect portability: no device-exclusive core workflow, required aggregator/provider, proprietary export, or AI-only user experience.

### Security, governance, and provenance

- Financial money is integer minor units; all cross-boundary/API/CLI inputs receive runtime schema validation; secrets are encrypted; least privilege, redacted notification policy, approved messaging identities, rate limits, timeouts, backup-before-first-write/upgrade, and unauthorized-read/write testing are mandatory.
- Notification delivery is application infrastructure, not a model capability: each delivery is bound to an authorized current recipient and an approved messaging identity; content is redacted by policy; attempts, provider acknowledgements, failures, and suppression are auditable; stable delivery keys make retries non-duplicating; and provider/channel failure is visible without blocking ledger, review, or deterministic work.
- Audit storage is append-oriented application metadata, not marketed as tamper-proof. Preserve event history through migrations; document retention/deletion; keep encrypted backups and restore tests. Add cryptographic chaining/external immutability only if the threat model requires it.
- Repository governance requires Apache-2.0, DCO sign-off on every commit, protected default branch, pull request/CI/review requirements, no direct pushes, Code of Conduct, contribution/governance and security policies, private vulnerability route, dependency/license/secret scanning, third-party notices, release signing/build provenance, and trademark policy.
- If Actual AI code is copied or materially adapted, retain its MIT copyright and license, source repository/commit, affected components, and modification record in `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES`. Ideas and observed behavior may be independently implemented without source incorporation.

### Roadmap stop conditions

Stop, simplify, or reconsider a phase when review is not faster than Actual, corrections remain high, rules do not reduce repeat work, Actual upkeep/self-hosting becomes fragile, users cannot explain decisions or find missing data without logs, the review backlog does not decline, ledger/project totals diverge without scope explanation, routine work requires a model/chat, collaboration needs broad credential sharing, exports/disconnect are unsafe, or ongoing maintenance exceeds the value over Actual alone.

### Metrics required through the MVP

Track median review time; accepted and corrected suggestion rates; unresolved-backlog age; deterministic-rule coverage; model calls per imported transaction; monthly model cost; false automatic application count; reconciliation ambiguity; monthly maintenance time; connection-health failure rate and time to visible detection; stale-data conclusions; unexplained ledger/project discrepancies; duplicate and false-merge count; median approval/correction interactions; repeated-correction rate by pattern; review items created versus exceptions resolved; all-models-disabled core-workflow pass rate; export/disconnect/restore success rate; and operator interventions per month.

### Open questions requiring later evidence

- Trademark clearance and brand-protection strategy for BalanceFrame.
- SQLite library and migration tool.
- Exact N-API binding, schema-generation, TypeScript-generation, and native packaging toolchain after a thin vertical-slice proof.
- Exact supported native platform/architecture matrix beyond initial container-first Linux x86-64 and ARM64.
- Actual API/server compatibility policy.
- Exact Actual authentication behavior for user-owned multi-user/OIDC deployments.
- Whether API-applied categorization triggers Actual automatic category learning and how to control it.
- When SQLite ceases to be appropriate for hosted operation.
- Whether another ledger backend should be supported before a custom ledger is considered.
- Exact shared-event protocol and coordinator trust model.
- Retention and deletion rules for linked-space historical financial records.
- Calibration method for classification quality and automation eligibility.
- Notification channels and privacy defaults.
- Legal review of licensing, trademarks, hosted terms, and financial-data obligations.

### Competitive evidence posture

This section records qualitative product lessons from public user communities, official product forums, product help centers, long-form user reviews, and recurring discussions about six budgeting products: Monarch Money, YNAB, Quicken Simplifi, Rocket Money, Goodbudget, and Copilot Money. The research was performed in July 2026. Community feedback is not a statistically representative customer survey: people with failures are more likely to post; product-specific communities may overrepresent enthusiasts; account-connection quality varies by institution and aggregator; products change after posts are written; some complaints reflect a product's chosen budgeting philosophy rather than a defect; and reviewers sometimes repeat marketing claims without long-term use. The findings describe repeated qualitative themes, not measured prevalence. Product requirements derived from them must still be validated with BalanceFrame's own users.

No reviewed product wins every dimension. Users generally choose among three different jobs: (1) plan every available dollar (YNAB, Goodbudget), (2) see the complete financial picture (Monarch, Simplifi, Copilot), and (3) find immediate savings with little setup (Rocket Money). The opportunity is not to copy all three into one overloaded dashboard but to combine Actual's rigorous envelope budget and deterministic rules, a fast polished exception-review experience, transparent cash-flow/recurring/net-worth views, optional subscription/anomaly intelligence, flexible personal/shared/linked spaces, local ownership and provider choice, and explicit uncertainty when imported data is incomplete.

#### Monarch Money

Valued for: polished approachable interface; consolidated dashboard spanning cash, debt, investments, property, and net worth; flexible categories/tags/rules/merchant cleanup; reports and trends; recurring transaction and cash-flow visibility; goals alongside the wider financial picture; couples/shared financial management; multiple connection providers as fallback; no advertising-driven interface. Criticized for: subscription price feeling high when sync is unreliable; stale/missing/duplicate transactions undermining trust in every report; inconsistent aggregator behavior; noisy recurring detection; rule surprises; budget less intuitive to envelope users; goals/forecasts/budgets/reports not reconciling into one explanation; mobile/web reporting gaps; support frustration acute because connection failures affect financial truth.

#### YNAB

Valued for: the method — give every dollar a job, plan with money already available, make tradeoffs explicit by moving money between categories, use targets for irregular/future expenses, reconcile and trust the budget, recover from overspending; mature envelope semantics; fast entry and reconciliation; targets and schedules; shared budgeting; API and ecosystem; clear opinionated philosophy. Criticized for: steep conceptual learning curve; confusing credit-card payment behavior; feeling like work until habitual; price increases hard to accept with manual import or unreliable direct import; bank coverage/sync varying by country; limited reports especially on mobile; secondary investment/net-worth analysis; rigid month rollover/overspending behavior; terminology resisting forecasting workflows; shared budgeting not solving selective privacy among roommates or partially independent partners.

#### Quicken Simplifi

Valued for: flexible Spending Plan rather than requiring every dollar assigned; recurring income/bills/subscriptions in expected cash flow; Planned Spending for flexible categories; Watchlists for focused monitoring; broad account aggregation; reports and net-worth; lower price; web and mobile access; enough manual control for tracking-plus-planning. Criticized for: missing/duplicate transactions; connected accounts reporting success but not staying current; incorrect automatic categorization; limited rule conditions (no amount/account awareness); recurring detection/matching errors; confusion over bills/subscriptions/Planned Spending/Spending Plan interactions; split transactions inconsistent across reports/exclusions; report filters/views not persisting; mismatches between transaction lists/reports/planning views; hidden/excluded transactions producing surprising totals.

#### Rocket Money

Valued for: discovering forgotten subscriptions; showing recurring charges in one place; helping cancel subscriptions; negotiating bills; simple spending summaries and alerts; broad aggregation; usable free entry point; clear first-session "money found or saved" outcome. Criticized for: shallow budgeting/categorization; subscription detection missing or misclassifying; cancellation assistance not universal; sync problems weakening comprehensive view; confusing premium pricing/feature boundaries; repeated upsell pressure conflicting with money-saving message; wariness of linking extensive financial data; bill-negotiation charges surprising if annualized savings and fee timing not understood; negotiated plans changing service terms unexpectedly. Rocket Money's help center confirms bill negotiation costs 35%–60% of first-year annualized savings, charged automatically after a 48-hour window.

#### Goodbudget

Valued for: understandable envelope metaphor; manual entry creating deliberate awareness; planned allocations making tradeoffs visible; cross-device sync for couples/shared budgets; simpler setup; usable without connecting every institution; free tier; debt and savings planning coexisting with envelopes. Criticized for: substantial manual work when sync unavailable/unreliable; geographic gaps in supported institutions; cleared transactions arriving late or not at all; duplicates when changing import methods or when bank identifiers change; confusing credit-card payment/envelope treatment; limited/dated reporting; free-tier restrictions; multi-step account/envelope transfers; import workflows requiring users to prevent overlapping date ranges manually; less polished interface.

#### Copilot Money

Valued for: fast attractive Apple-native interfaces; strong transaction-review ergonomics; category rules and merchant recategorization; useful recurring detection; flexible tags and category organization; combined spending/account/investment/net-worth views; visualizations making routine review pleasant; responsive interaction and low-friction onboarding; model-assisted categorization presented as convenience not authority. Criticized for: historically narrow platform availability (especially no Android); premium price; bank/investment sync failures; incorrect categories and recurrence predictions; budgeting feeling more like spending tracking than proactive envelope planning; reporting and export gaps; slow delivery of requested features; limited collaboration and role separation; partner sharing meaning shared full control rather than independent identity/permission.

#### Shared lesson

The shared lesson is decisive: no polished dashboard, envelope method, subscription feature, model, or collaboration feature compensates for stale/missing/duplicate transactions, opaque rules, non-reconcilable totals, forced provider dependence, or credential-sharing collaboration. The phase acceptance gates translate these lessons into observable requirements rather than copying competitor scope.

#### Cross-product approaches to lean into

- Trustworthy ingestion before advanced intelligence: connection health is a top-level surface; completeness and freshness accompany every insight; import/reconciliation incidents block affected advice; manual entry always available; duplicate review is first-class UX; "last successful sync" not buried in settings.
- An actionable home surface: actions requiring attention, then data-quality blockers, then category/cash-flow risks, then recent meaningful changes, then target progress, then optional net-worth context — not a wall of charts.
- Two complementary planning lenses: envelope (money available and assigned by category, authoritative for spending advice) and cash-flow (expected income/bills/subscriptions/projected balances, a projection with assumptions). Never conflated.
- Fast exception review: grouped review, keyboard/touch efficiency, clear suggestion evidence, one-action correction, undo, rule proposal from repeated corrections, visible backlog age/count, no model prose for obvious cases.
- Selective collaboration: independent identities, personal/shared-ledger/linked spaces, scoped visibility, proposal/approval separation, temporal membership, no credential forwarding, no automatic exposure of private accounts.
- Education at the point of confusion: explain why category availability differs from account balance, why credit-card payments are transfers not spending, why a transaction was excluded, why data is insufficient, why a rule matched, what a reallocation sacrifices, what pending transactions change.
- User-owned automation: inspectable, editable, testable against history, ordered with visible precedence, disableable, exportable, reversible, attributable.
- Immediate value with progressive depth: onboarding produces a useful read-only result quickly — uncategorized backlog, repeated merchants, likely subscriptions, stale-connection warning, duplicate candidates, categories with repeated corrections — without complete policy configuration.
- Portability and graceful exit: export, backup, disconnect, and removal are ordinary supported operations.

#### Cross-product approaches to avoid

- Opaque or unreliable financial truth: silently stale balances, hidden transactions, unexplained duplicates, ambiguous transfer treatment, totals differing without scope labels, rules without provenance, model changes presented as facts.
- Collaboration by credential sharing: shared passwords or forwarded login links, all members full control, role labels without resource scopes, deleting departing members' historical identity, copying private ledgers into shared spaces.
- A second full-time budgeting job: multiple competing inboxes, repeated correction of the same pattern, excessive setup before first value, mandatory chat for routine actions, manual import mechanics users must memorize, asking users to reconcile implementation details.
- Unclear automation: model confidence as authorization, recurrence detection without evidence, merchant-only rules where context matters, silent category learning, inability to preview historical effects, broad automatic category or budget creation.
- Monetization that conflicts with user outcomes: ads based on financial behavior, sale or secondary use of transaction data, percentage-of-savings fees without exact proposal-bound consent, constant upsells, withholding backup/export/audit/security/local-provider support, making the hosted service the only practical version.
- Platform and provider lock-in: Apple-only/Android-only/desktop-only core workflows, one required bank aggregator, one required model provider, proprietary export formats, UX that collapses when AI is disabled, direct coupling of project domain types to Actual.

#### Competitive research references

- Monarch Money Shared Views announcement: <https://www.reddit.com/r/MonarchMoney/comments/1oji69f/couples_this_ones_for_you_shared_views_is_here/>
- Monarch Money sync frequency control request: <https://www.reddit.com/r/MonarchMoney/comments/1rax07o/control_account_sync_frequency_disconnect_due_to/>
- YNAB community better-reports project: <https://www.reddit.com/r/ynab/comments/1czorqx/update_1_on_building_better_reports_aka_ynabr/>
- YNAB rollover complaint: <https://www.reddit.com/r/ynab/comments/1pzrlz0/my_only_complaint_with_ynab_is_the_inability_to/>
- Simplifi incorrect categorization: <https://community.simplifimoney.com/discussion/15647/how-can-i-make-quicken-automatically-put-transactions-in-the-right-category>
- Simplifi amount/account-aware rules request: <https://community.simplifimoney.com/discussion/1340/ability-to-create-transaction-rules-for-amounts-and-accounts-edited-7-merged-vote/p5>
- Rocket Money bill-negotiation charge: <https://help.rocketmoney.com/en/articles/9744474-bill-negotiation-charge-explained>
- Goodbudget sync failure thread: <https://forums.goodbudget.com/t/my-synced-bank-accounts-are-not-syncing/3725>
- Goodbudget duplicate imports: <https://forums.goodbudget.com/t/importing-bank-transactions-doesnt-detect-transactions-that-have-been-previously-imported/3756>
- Copilot Money web app docs: <https://help.copilot.money/en/articles/11780342-copilot-money-for-web>
- Copilot Money partner sharing: <https://help.copilot.money/en/articles/4523792-sharing-your-account-with-a-partner>
