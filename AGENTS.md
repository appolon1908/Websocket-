# Codestra Agent Governance Standard

Every task belongs to Product → Section → Subsection → Atomic Task.

Valid promotion path only:

atomic task → subsection branch → section branch → development → testing → staging → production

No other promotion path is accepted.

## Ownership and leases

Each active subsection has exactly one implementation owner. Review, test, certification, and investigation agents may assist but must not independently edit the same implementation scope unless explicitly assigned.

Allowed states: NOT_STARTED, CLAIMED, IN_PROGRESS, BLOCKED, REVIEW, COMPLETE, CERTIFIED.

Abandoned leases may be reclaimed only after the configured heartbeat timeout and worktree inspection.

## Mandatory pre-work synchronization

Before editing: fetch/prune origin; verify workstation and parent branch; record HEAD SHA; verify clean tree; record ahead/behind; synchronize safely from parent; run preflight; verify production-effect gates remain disabled.

Stop on unexplained local changes, divergence, invalidated base assumptions, conflicts, missing required dependencies/credentials, or uncertain safety. Never overwrite unknown local work.

## Atomic implementation

Every atomic task includes applicable implementation, tests, error handling, contracts, documentation, migrations, observability, and security review. Do not combine unrelated changes.

## Code quality

Completion is prohibited with placeholder code, TODO-as-implementation, dead/duplicate code, temporary bypasses, broad exception swallowing, hard-coded credentials, production secrets, unexplained lint suppression, disabled tests, skipped security checks, or temporary production flags.

## Test before push

Run applicable formatting, lint, types, unit, integration, contract/OpenAPI, migration, security, secret scan, and git diff --check gates before every checkpoint push. Do not knowingly push broken code.

## Push discipline

After each atomic checkpoint: validate, commit intended changes, push branch, verify remote SHA, update mission status, record blockers. Do not end with unexplained uncommitted implementation work.

## Commit standard

One understandable unit per commit. Avoid meaningless messages such as update, fix, changes, or stuff.

## Parent synchronization

Before merge request: fetch remote; compare parent; integrate current parent safely; resolve conflicts intentionally; rerun required tests; push refreshed exact branch; require CI on the new exact SHA. Old CI evidence does not certify changed code.

## Protected branches

Do not directly develop on main, development, testing, staging, or production. Protected branches move only through approved pull requests and required checks. Force pushes are prohibited.

## Production effects default OFF

Unless a separately approved production activation mission changes them:

PRODUCTION_GO=NO
LIVE_CAPABILITIES_ENABLED=NO
EXTERNAL_EFFECTS=false

Implementation missions must not silently enable calls, SMS, email, WhatsApp, payments, social publishing, production database mutation, production infrastructure changes, credential issuance, or external media publishing.

## Completion evidence

Every completed subsection records final branch/SHA, parent SHA, changed files, tests/results, security result, migration result, API/contract result, dependency changes, limitations, remaining TODOs, CI result, and reviewer result. Missing evidence means not COMPLETE.

## COMPLETE

COMPLETE requires implementation present, applicable local/integration/contract/security tests green, current documentation, valid migrations, branch pushed, clean tree, local/remote SHA match, and no unresolved blockers.

## CERTIFIED

CERTIFIED additionally requires exact-SHA CI green, independent review, parent integration success, regression/security/performance gates as applicable, no unresolved critical/high defects, and stored completion evidence. Only CERTIFIED work may promote.

## Cleanup

After parent integration, verify exact intended changes are present, remove obsolete temporary worktrees/locks, archive evidence, prune stale local refs, preserve unmerged branches, and retain recovery references where required.

## Fail closed

When safety cannot be proven, stop and mark BLOCKED. Never guess around secrets, migrations, authorization, branch ancestry, production effects, destructive operations, or incomplete CI evidence.
