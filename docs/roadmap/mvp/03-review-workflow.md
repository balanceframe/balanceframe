# Phase 3 — Review workflow

**Depends on:** Phase 2  
**Status:** Upcoming  
**Product-validation gate:** Do not build later platform phases unless this phase succeeds.

## Objective

Make unresolved categorization faster and less burdensome than categorizing directly in Actual. The result is one responsive, durable exception inbox—not a second full-time budgeting job or competing queues.

## Deliverables

### Review item lifecycle

Implement durable state and idempotent transitions:

```text
candidate discovered → suggestion generated → pending review
  ├─ approved → applying → applied | apply_failed
  ├─ corrected → applying corrected category
  ├─ rejected
  ├─ skipped
  └─ superseded
```

Review items carry transaction/version, suggestion/evidence/provenance, actor history, freshness, expiry where applicable, and stale/superseded reason. Do not create duplicate attention items for the same underlying issue.

### Signature interaction

- Provide responsive web and JSON CLI review commands. Critical workflow parity covers keyboard and touch, not a platform-specific native app.
- Support approve, correct, reject, skip, grouped review where evidence is homogeneous, bulk handling, undo where reversible, immediate progression, one-action common approval, and a correction in only a few actions.
- Present original imported name, normalized merchant, account, amount, current category, suggested category, alternatives, history, deterministic/model provenance, freshness, and exactly what acceptance would change. Example evidence: prior approved merchant classifications and their count—not opaque confidence prose.
- Prioritize stale blockers and material/high-value ambiguity. Keep one prioritized attention surface across categorizations, duplicate/reconciliation issues, proposed rules, and later alerts; do not make every observation a review item.
- Audit creation, viewing, action, errors, and stale/superseded events with correlation IDs and provenance.

### Measurement and quality bar

Measure median review time, interactions per approval/correction, acceptance/correction rates, backlog count and age, coverage, interaction latency, repeated-pattern recurrence, duplicates avoided, deterministic-rule conversion potential, and review items created versus actual exceptions resolved.

The home/first review surface prioritizes action, data-quality blockers, meaningful changes, category/cash-flow risk, targets, and optional net-worth context—not decorative charts. Explain envelope availability versus balance, projections, pending effects, and data insufficiency at the point of confusion.

## Tests

Bulk-review conflicts; stale/superseded items; two reviewers; undo consistency; grouped-review heterogeneity; keyboard/touch parity; inaccessible provider; model-disabled review; duplicate attention prevention; original imported evidence visibility; and web/CLI semantic consistency.

## Exit

**Measured testing shows review is faster or less burdensome than direct Actual categorization.** If this fails, stop or simplify: a high suggestion count is not success, and later intelligence, chat, collaboration, subscriptions, affordability, or federation have not been earned.