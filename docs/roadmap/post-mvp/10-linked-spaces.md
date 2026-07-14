# Phase 10 — Linked spaces

**Depends on:** Phase 7 governance and Phase 9.5 delegation controls  
**Status:** Post-MVP

## Objective

Let independently operated BalanceFrame and Actual instances coordinate selected expenses and targets without sharing credentials, copying private ledgers, or querying through to another participant's financial records.

## Deliverables

### Projection-first coordination

Each participant retains a personal space, private Actual connection, private accounts/transactions/policies, and independent identity. A linked space stores only deliberate coordination records:

- shared expense definitions and bills;
- contribution obligations and reimbursement requests;
- shared targets and settlement state;
- approved aggregates and selectively disclosed evidence;
- membership and policy events.

**Privacy invariant:** a private instance publishes an explicit, approved projection; the linked space never queries through to the private ledger. Do not require a member's Actual credentials, force a joint budget, or expose unrelated private accounts.

### Temporal membership and events

- Add temporal membership, revocation, effective departure dates, replacement memberships, export, and historical attribution.
- On departure, revoke future access, prevent new obligations after the effective date, retain required settled/outstanding records according to policy, preserve historical membership references, and prevent access to newly created shared records. A replacement never inherits another person's identity or private references.
- Design shared records as versioned events that can later be signed and synchronized. Begin with a coordinator rather than peer-to-peer federation to simplify discovery, offline delivery, notifications, conflict handling, revocation, and schema upgrades.
- Add signed/versioned event verification and deterministic reducers only after the core event/projection model is stable. Linked-space events may later be a Rust expansion boundary, but no Rust ledger daemon is introduced here.

### Linked-space deletion and retention

Deletion of BalanceFrame-owned data must not silently erase another participant's required coordination history or outstanding settlement state. Treat a participant's local disconnect/removal, a linked-space membership departure, and deletion of shared coordination records as separate operations.

- Before deleting linked-space data, inventory the participant-local projections, shared expense/bill/target records, contribution and reimbursement obligations, settlement state, membership/policy events, approved aggregates, selectively disclosed evidence, queued events, and backups affected by the request. Offer export and show which records remain, their retention policy, and the reason.
- A participant may revoke future projection publication, delivery credentials, and future access immediately according to policy. Revocation must not mutate that participant's private Actual ledger or give the coordinator access to it.
- Do not delete records needed to explain settled history, preserve membership attribution, resolve outstanding obligations, satisfy a configured retention requirement, or safely replay/resolve an in-flight event. Retained records must remain access-controlled, minimised to the approved shared fields, and visibly identified in deletion results.
- When retention permits deletion, tombstone or delete the shared record through the versioned event model so replicas/coordinator recovery do not resurrect it. Prevent queued projection, notification, or obligation events from recreating deleted access or records after revocation.
- A replacement membership never inherits deleted or retained private references. Complete application removal reports linked-space records that require a separate coordinated retention process rather than claiming that another participant's copy was erased.

Test local removal, departure, scoped deletion, retention-blocked deletion, export-before-delete, revoked projection keys/destinations, queued-event suppression, deletion-event replay/conflict/recovery, outstanding settlement preservation, private-ID non-disclosure, and participant-visible retention reasons.

### Product modes

Make the distinction explicit:

- **Shared-ledger space:** members deliberately use one Actual budget.
- **Linked space:** private spaces publish selected coordination projections.

This supports individuals, couples, families, roommates, co-parents, and temporary groups without imposing one privacy model.

## Tests

Approved-field-only projections; private backend ID non-disclosure; offline delivery; duplicate/replayed events; conflicting updates; schema/version upgrades; revoked key; departure/replacement; historical retention; outstanding settlement; revocation; coordinator failure/recovery; and export.

## Exit

**Participants coordinate chosen expenses and targets while unrelated private ledger data, credentials, and identifiers remain undisclosed.**