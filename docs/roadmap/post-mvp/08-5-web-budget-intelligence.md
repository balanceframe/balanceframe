# Phase 8.5 — Web budget intelligence and extended analysis

**Depends on:** Phase 8 budget intelligence, trustworthy gateway, governance, and MVP evidence  
**Status:** Planned  
**Scope:** Web presentation, Phase 8 runtime completion, and additional deterministic budget-intelligence analysis

## Objective

Turn Phase 8's deterministic analysis APIs into a complete, accessible, responsive web experience while extending budget intelligence with additional conservative analysis that is not owned by the other post-MVP phases.

The web application is a presentation and workflow client. Rust and the application analysis layer remain authoritative for financial arithmetic, decision facts, reason codes, evidence, freshness, and policy application. The UI must never independently recompute financial conclusions, treat advice as permission, or treat a projection as current availability.

Phase 8.5 includes backend application/API work where the existing Phase 8 contract is not yet sufficient to support a complete UI. It does not execute reallocations, add conversational inference, link spaces, or perform merchant enrichment; those concerns remain with Phases 6, 9, 10, and 11 respectively.

## Current-state prerequisites and gaps

Phase 8 provides analysis and API surfaces for attention home, purchase evaluation, cash-flow projection, target health, sinking-fund health, reports, saved views, and notification status. Phase 8.5 must first close the following gaps before building dependent UI:

- Verify and repair web/CLI envelope parity for `dataFreshness`, authorization, scope, semantic labels, and error states. A web response must not omit freshness that the CLI provides.
- Distinguish healthy configured data, no configuration, unavailable data, unknown state, and `insufficient_data`. Empty schedules, targets, or sinking funds must not be presented as a globally healthy budget.
- Complete report lifecycle APIs if the UI is expected to browse persisted report history rather than only generate a report.
- Complete saved-view lifecycle APIs for rename, update, duplicate, delete, and last-used metadata where required by the UI.
- Add finding lifecycle state and evidence references for acknowledgement, correction, dismissal, reopening, expiry, and supersession.
- Wire `NotificationRuntime` through the application composition boundary with the `WorkflowStore`; do not make the status route the sole runtime constructor.
- Add deterministic notification event producers for eligible findings and consequential workflow events.
- Replace the notification status route's hardcoded policy and empty recipient configuration with persisted, authorized per-space policy and recipient resolution.
- Add notification inbox, detail, acknowledgement, suppression, policy, and delivery-processing contracts before implementing the notification UI.

These are prerequisites for a trustworthy UI, not optional polish.

## Design principles

- **Deterministic authority:** the UI displays application results; it does not calculate financial truth.
- **Semantic labeling:** every amount and conclusion is labeled as ledger fact, envelope availability, cash-flow projection, advice, proposal, or execution result.
- **Conservative uncertainty:** stale, incomplete, unavailable, ambiguous, and insufficient data remain visible and cannot silently become confident advice.
- **Evidence first:** every material conclusion exposes its scope, assumptions, policy, uncertainty, and drill-down records.
- **Advice is not authorization:** safe purchase advice never authorizes a purchase; a reallocation result never mutates the ledger.
- **Projection separation:** expected income and future obligations never increase current envelope availability.
- **Provider neutrality:** notification channels, exports, and analysis contracts remain independent of a particular delivery provider.
- **Responsive accessibility:** every chart has a table alternative; keyboard, screen-reader, mobile, reduced-motion, and high-contrast use cases are supported.
- **Web/CLI parity:** equivalent inputs produce equivalent structured facts, outcomes, reason codes, evidence scope, and freshness across web and CLI.
- **Failure isolation:** notification, chart, export, or optional analysis failures do not disable review, synchronization, or deterministic core workflows.

## Shared web foundation

### Authenticated application shell

Add a responsive application shell for authenticated users with:

- Overview
- Cash flow
- Targets and sinking funds
- Purchase check
- Reports
- Notifications
- Transaction review
- Rules

The shell includes the current budget/space, authorization scope, sync status, user menu, sign-out, mobile navigation, route-level pending state, and visible focus management. Existing review and rules workflows remain available without becoming subordinate to the intelligence surfaces.

### Shared components

Implement reusable components with contract-driven props:

- `AnalysisPage`: title, loading, retryable error, empty, insufficient-data, stale-data, scope, and refresh states.
- `FreshnessBanner`: Actual download time, bank sync time, snapshot age, pending inclusion, staleness, missing provider data, and affected surfaces.
- `SemanticAmount`: amount, currency, semantic class, and account/date scope.
- `ScopeSummary`: dates, accounts, categories, pending/uncleared policy, transfers, splits, reimbursements, and exclusions.
- `ReasonCodeList`: stable code, explanation, severity, evidence link, and next action.
- `EvidenceDrawer`: authorized transaction, category, account, schedule, target, policy, and freshness evidence.
- `InsufficientDataPanel`: blocker, impact, remediation, and unavailable conclusion.
- `FindingCard`: severity, lifecycle state, source, evidence, scope, and action.
- `AnalysisTable`: responsive table/card presentation, sorting, exact values, and export.
- `SavedViewPicker`: apply, create, update, duplicate, and delete saved views.
- `NotificationStatusBadge`: delivery state distinct from the state of the underlying finding.

Unknown reason codes and semantic classes must render safely without inventing a financial interpretation.

## Dedicated Phase 8 web surfaces

### Overview and attention dashboard

**Route:** `/`

Make the authenticated home page the actionable attention surface rather than a chart wall. Render, in priority order:

1. Data blockers.
2. Alerts and watchlists.
3. Cash-flow risk.
4. Category risk.
5. Target and sinking-fund progress.
6. Meaningful changes.
7. Recurrence and subscription observations.
8. Optional context.

Every item shows severity, why it appears, freshness, scope, evidence, and a concise next action. Notification acknowledgement, financial-finding dismissal, and source-data correction are separate actions with separate audit state.

### Purchase check

**Route:** `/purchase-check`

Provide category, amount, currency, and optional account inputs with applied policy visibility. Render all mandatory decisions:

- `safe`: category availability, future-month evidence, pending/uncleared/uncategorized treatment, and freshness.
- `safe_with_reallocation`: exact proposed reallocations, donor categories, protected categories, retained minimums, competition, expiry, and an explicit no-mutation statement.
- `not_safe`: shortfall, reason codes, protected-fund/cash-buffer impact, donor constraints, and evidence.
- `insufficient_data`: blockers, affected facts, remediation, and no inferred safe/not-safe answer.

Phase 8.5 displays advice and proposals only. It must not approve, execute, or apply a reallocation. Reallocation execution remains Phase 9.

### Cash-flow projection

**Route:** `/cash-flow`

Provide projection horizon, start month, account scope where supported, and pending/schedule assumptions. Render an accessible visualization and exact monthly table containing:

- Projected income.
- Projected expenses.
- Net change.
- Ending balance.
- Scheduled income count.
- Scheduled expense count.
- Data sufficiency and warning.
- Assumptions and uncertainty.

Current envelope availability and projected future balance must be visually and semantically separate.

### Targets and sinking funds

**Route:** `/targets`

Provide a combined health view with summary counts and detail rows for target and sinking-fund categories. Show target amount, current amount, required contribution, expected completion, progress, status, evidence, freshness, and next action.

Explicitly distinguish:

- No targets configured.
- No sinking funds configured.
- Healthy configured targets.
- At-risk targets.
- Fully funded, partially funded, and unfunded sinking funds.
- Unknown or insufficient data.

### Reports

**Route:** `/reports`

Provide report type, month range, pending treatment, and filter controls. Render report metadata, scope, transaction count, totals, currency, generated timestamp, freshness, applied filters, tags, and provider-independent export.

If report records are persisted, provide report history and stable report references. A generated result must never be mistaken for a live ledger view without its scope and freshness metadata.

### Saved views

Integrate saved views into Reports and Review. Support create, apply, rename, update, duplicate, delete, scope display, sort display, and last-used metadata where authorized.

A saved view stores filter intent, not an authoritative financial snapshot. The UI displays the current run's freshness separately from view creation or last-use metadata.

## Notification completion and web UI

### Runtime and backend completion

Before notification pages, implement the application-level notification lifecycle:

- Construct `NotificationRuntime` through composition with the active `WorkflowStore`.
- Load per-space policy and policy version.
- Resolve recipients by current membership, capability, and scope.
- Produce events from eligible data-quality findings, alerts, recurrence/duplicate findings, target risks, proposal state, and consequential action results.
- Persist immutable events before outbox records and delivery attempts.
- Re-authorize before dispatch.
- Apply current redaction policy at delivery time.
- Claim, dispatch, retry, suppress, fail, and acknowledge idempotently.
- Expose audit and correlation identifiers.
- Keep provider/channel failure isolated from financial analysis and synchronization.

### Notification pages

**Route:** `/notifications`

Provide:

- Inbox/status list for pending, delivered, suppressed, failed, retrying, and acknowledged records.
- Source finding/proposal links.
- Delivery timestamps, attempt history, policy version, and redaction class.
- Acknowledgement and suppression controls that change notification workflow state only.
- Recipient and channel policy controls.
- Event classification and minimum severity.
- Quiet hours, digest/coalescing, rate limits, escalation, redaction, and destination verification.
- All-channels-disabled and provider-outage states.

Notification delivery is never displayed as proof that a financial conclusion is current. The originating finding or proposal remains authoritative.

## Additional budget-intelligence features

The following features extend Phase 8 without overlapping the responsibility of other future phases. Each item includes both deterministic backend work and dedicated web presentation.

### Data-quality center

#### Backend logic

Create a consolidated, versioned data-quality analysis over:

- Uncategorized exposure.
- Pending availability and identifier stability.
- Uncleared exposure.
- Stale budget snapshots and bank syncs.
- Authorization-to-posting delay.
- Late posting.
- Duplicate pending/posting ambiguity.
- Manual-entry frequency.
- Missing schedules.
- Account/provider freshness and connection failures.

Merchant identity mismatch and enrichment remain Phase 11 concerns. Each observation includes severity, affected analysis surfaces, evidence references, blocking versus qualifying impact, policy applied, first observed time, latest observed time, and remediation state. Findings reopen when materially changed evidence invalidates a prior dismissal.

#### Web UI

**Route:** `/data-quality`

Provide an actionable quality table and detail drawer with:

- Severity and lifecycle state.
- Affected pages and conclusions.
- Exact evidence and scope.
- Applied policy.
- Remediation steps.
- Blocked versus qualified analysis labels.
- Historical trend for recurring quality issues.

### Liquidity runway and obligation coverage

#### Backend logic

Add a conservative coverage analysis using envelope availability and cash-flow projections as separate inputs. Calculate:

- Covered known obligations over configurable 30/60/90-day windows.
- Projected minimum balance and date.
- Cash-buffer breaches.
- Unfunded upcoming obligations.
- Obligations dependent on uncertain income.
- Coverage ratio with explicit assumptions and uncertainty.

Known schedules, recurrence candidates, pending transactions, transfers, reimbursements, and excluded accounts must be identified in evidence. Projected income must never increase current availability.

#### Web UI

**Route:** `/liquidity`

Show:

- Coverage horizon selector.
- Minimum projected balance and date.
- Covered and uncovered obligation totals.
- Cash-buffer status.
- Obligation timeline.
- Assumptions, uncertainty, and scope.
- Evidence drill-down.

### Bill and obligation calendar

#### Backend logic

Create a unified chronological projection over:

- Scheduled bills.
- Recurring-charge candidates.
- Expected income.
- Target contributions.
- Annual and irregular obligations.
- Pending transactions affecting the near-term period.

Each event carries source type, certainty, expected amount, date range, category/account, semantic class, and evidence. Conflicting or ambiguous dates remain visibly uncertain.

#### Web UI

**Route:** `/calendar`

Provide:

- Month and timeline views.
- Event-type filters.
- Certainty filters.
- Obligation coverage indicators.
- Income versus expense separation.
- Event detail/evidence drawer.
- Accessible list alternative to the calendar.

### Budget variance and trend analysis

#### Backend logic

Add deterministic planned-versus-actual analysis for:

- Category budget versus actual spending.
- Month-over-month changes.
- Rolling averages.
- Persistent overspending and underspending.
- Category volatility.
- Meaningful change thresholds.
- Pending and uncategorized treatment.

Variance results include calculation period, comparison basis, excluded records, confidence limitations, and transaction/category evidence. This analysis diagnoses behavior and does not reallocate funds.

#### Web UI

**Route:** `/trends`

Provide:

- Period and comparison selectors.
- Category variance table.
- Trend visualization with table alternative.
- Persistent-variance findings.
- Transaction evidence.
- Budget versus actual semantic labels.
- Export and saved-view support.

### Annual and irregular expense planner

#### Backend logic

Support user-configured irregular obligations such as insurance, taxes, repairs, gifts, travel, tuition, medical expenses, and memberships. Calculate:

- Required periodic contribution.
- Current funding.
- Expected due date.
- Funding shortfall.
- Completion trajectory.
- Evidence and uncertainty.

This extends sinking-fund analysis without executing transfers or reallocations.

#### Web UI

**Route:** `/obligations`

Provide:

- Obligation list and detail pages.
- Due-date and contribution editor.
- Funding trajectory.
- Required versus current contribution.
- At-risk and unfunded filters.
- Evidence and semantic labels.
- Clear distinction between user planning input and ledger fact.

### Income reliability

#### Backend logic

Analyze historical income observations:

- Pay cadence.
- Amount variance.
- Late or missing expected income.
- Income-source concentration.
- Historical reliability.
- Earliest/latest observed timing window.

Outputs are observations with confidence and evidence. The engine must not promise future income or silently change the budget.

#### Web UI

**Route:** `/income`

Provide:

- Income-source summary.
- Cadence and amount-variance views.
- Late/missing income findings.
- Concentration and dependency warnings.
- Historical evidence.
- Explicit uncertainty labels.

### Forecast calibration

#### Backend logic

Compare prior cash-flow projections with subsequently observed ledger facts:

- Projected versus posted income.
- Projected versus posted expenses.
- Forecast error by category or source.
- Systematic underestimation or overestimation.
- Projection confidence trend.

Calibration is diagnostic. It must not silently rewrite prior reports or alter policy without explicit versioning.

#### Web UI

**Route:** `/forecast-accuracy`

Provide:

- Forecast-versus-actual chart and table.
- Error by month/category/source.
- Confidence trend.
- Data-quality exclusions.
- Projection version and assumptions.
- Explanation of why a forecast was inaccurate.

### Read-only scenario comparison

#### Backend logic

Add immutable, analysis-only scenarios for controlled inputs such as:

- One pay cycle delayed.
- Expense increased by a fixed amount.
- One-time purchase added.
- Target contribution paused.
- Cash buffer increased.
- Recurring obligation removed.

Each scenario has a stable ID, input assumptions, policy version, source snapshot, result version, expiry, and explicit projection semantic class. Scenarios never mutate the ledger, envelopes, targets, or notification state.

#### Web UI

**Route:** `/scenarios`

Provide:

- Scenario builder.
- Side-by-side baseline and scenario projections.
- Changed assumptions.
- Minimum balance and obligation coverage differences.
- Save/export controls where authorized.
- Explicit read-only and projection labels.
- Reset and compare actions.

### Explainable multidimensional budget health

#### Backend logic

Produce independent dimensions rather than one opaque score:

- Data quality.
- Liquidity.
- Category funding.
- Obligation coverage.
- Target progress.
- Income stability.
- Forecast confidence.

Each dimension supports healthy, at-risk, unknown, and not-configured states, with evidence, thresholds, policy version, and calculation timestamp. The aggregate view must not conceal unknown dimensions.

#### Web UI

**Route:** `/health`

Provide:

- Dimension cards.
- Detail and evidence drill-down.
- Threshold and policy display.
- Unknown/not-configured handling.
- Historical state changes.
- Links to the page that can remediate each issue.

## API and contract requirements

Every Phase 8.5 endpoint must provide a consistent envelope containing:

- Schema version.
- Request ID.
- Status.
- Authorization context.
- Data freshness.
- Result or structured error.
- Applied policy version where relevant.
- Scope and semantic classes.
- Evidence references where relevant.

The API must support:

- Stable pagination and sorting.
- Stable identifiers.
- Explicit no-configuration states.
- Retryable versus terminal errors.
- Redaction and authorization at retrieval time.
- Provider-independent export.
- Correlation IDs for findings, notifications, reports, and scenarios.

## Testing and exit criteria

### Component tests

Test loading, retry, empty, no-configuration, stale, missing-freshness, insufficient-data, unknown-reason, negative-amount, currency, long-label, keyboard, screen-reader, mobile, reduced-motion, and high-contrast behavior.

### Backend and contract tests

Test:

- Web/CLI parity.
- Freshness propagation.
- Scope propagation.
- Authorization and redaction.
- Stale and incomplete data.
- No-target and no-schedule semantics.
- Finding lifecycle transitions.
- Report and saved-view lifecycle.
- Scenario immutability.
- Notification event eligibility.
- Recipient reauthorization.
- Quiet hours, rate limits, digest, escalation, suppression precedence.
- Idempotent outbox retry and crash recovery.
- Provider acknowledgement, failure, malformed callback, and outage.
- All-channels-disabled operation.
- No ledger mutation from notification acknowledgement, reply, or scenario use.

### Browser acceptance scenarios

The web test fixture must cover:

1. Overview with uncategorized blockers.
2. Safe purchase.
3. Not-safe purchase.
4. Safe-with-reallocation proposal with no mutation.
5. Insufficient purchase data.
6. No schedules and insufficient cash-flow data.
7. Populated cash-flow schedules.
8. No targets configured.
9. Populated target health.
10. No sinking funds configured.
11. Populated sinking-fund health.
12. Report generation and export.
13. Saved-view create, apply, update, and delete.
14. Data-quality blocker and remediation.
15. Liquidity runway with an upcoming uncovered obligation.
16. Obligation calendar with uncertain recurrence.
17. Budget variance and persistent trend.
18. Annual/irregular obligation shortfall.
19. Income reliability warning.
20. Forecast calibration mismatch.
21. Read-only scenario comparison.
22. Notification delivery failure and suppression.
23. Unauthorized evidence access.
24. Responsive mobile navigation.
25. Disabled notification channels.

### Exit

Phase 8.5 is complete when:

- Every Phase 8 analysis surface has a dedicated accessible web workflow.
- Empty, unknown, stale, and insufficient-data states are visibly distinct.
- Web and CLI results have verified semantic parity.
- Every displayed amount has semantic class, scope, freshness, and policy context.
- Evidence drill-down is authorized and available for material conclusions.
- Reports and saved views have complete lifecycle behavior required by the UI.
- Notification events, outbox, delivery, policy, redaction, authorization, audit, retry, and failure behavior work end to end.
- Additional intelligence features have deterministic backend contracts and dedicated web pages/components.
- Scenario analysis and UI controls cannot mutate ledger state.
- Accessibility, responsive behavior, provider outages, and all-channels-disabled operation are tested.
- The existing review, reconciliation, rules, synchronization, and manual workflows remain usable when optional analysis or notification services fail.

**See also:** [Budget intelligence](08-budget-intelligence.md), [Controlled reallocations](09-controlled-reallocations.md), [Delegated operational autonomy](09-5-delegated-operational-autonomy.md), [Merchant intelligence and enrichment](11-merchant-intelligence-and-enrichment.md)
