# AlpineBrick — Engineering Workspace

This is the Claude Code workspace for AlpineBrick' platform build. It's the engineering counterpart to the Cowork "boardroom" in the parent folder. The two are deliberately separate: this directory is where the IT/Engineering org lives and codes; the parent folder holds the company plan, org structure, back-office agents, and shared knowledge.

## What's being built here
Four systems plus the cross-cutting concerns that tie them together:

1. **Retail website / storefront** — catalog, cart, checkout (Stripe), accounts.
2. **Order management system (OMS) / inventory control** — order processing, fulfillment, inventory.
3. **Affiliate marketing app** — partner accounts, referral codes, **flat-%** commission engine, payouts (Stripe Connect).
4. **Sales processing** — the checkout + payment flow + post-purchase handling that spans storefront and OMS.

Cross-cutting:
- **Interaction tracking & analytics** — events, customer journeys, and **affiliate attribution captured at the order level** (non-negotiable).
- **AlpineBrick MCP connector** — exposes orders/inventory/customers/affiliates/referrals as MCP tools so the back-office agents in the parent folder can read this platform's data.

## Locked decisions to respect
- Custom web app (not Shopify). **Stripe** for payments. **Stripe Connect** is the likely mechanism for affiliate payouts.
- **Flat-%** affiliate commission model.
- **Affiliate attribution captured at the order level from day one.**
- Design schemas/APIs to be exposable later via the MCP bridge.
- Approvals: branch + review for code; **Jack approves** architecture, stack, infra, deploys, external spend, and connecting live services.

## How this workspace is organized (initial)
- `.claude/agents/` — engineer subagents. **Engineering Lead** is hired and ready (`engineering-lead.md`). Other roles are planned and will be hired here as work demands.
- `CLAUDE.md` — this file; shared engineering context.
- Repo structure (monorepo vs. multi-repo, packages, etc.) is the Engineering Lead's first decision with Jack. Nothing committed to that shape yet.

## Where to find the back-office context
- `../../docs/alpinebrick-agent-plan.md` — the agent roster and roadmap
- `../../docs/alpinebrick-org-structure.md` — the company org & charters
- `../agents/IT-Org-Hiring-Plan.md` — the IT org and engineer roles
- `../agents/Agent-Registry.md` — every agent's status and permissions
- `../Session-Handoff-2026-05-22.md` — the most recent state-of-play

## Conventions (to be expanded by the Engineering Lead)
- Branch + PR for every change; no direct commits to main.
- **Every agent branches off `main` for its own work — never commit onto a branch
  you did not create.** Start with `git checkout -b <type>/<slug> main`, even when
  another branch is already checked out. Committing onto someone else's branch is
  how work gets stranded: on 2026-08-07 a `feat(core)` schema commit landed on an
  already-pushed `chore/` branch, the PR merged the commits that were on the
  remote, the branch was deleted, and the migration survived only because
  `git branch -d` refused. Recovered as PR #11. **A merge looking complete is not
  evidence that it is** — if `-d` refuses, stop and read the commits before
  reaching for `-D`.
- **Say who you are in the commit.** Every commit here authors as the same human
  identity, so the author line cannot tell one agent from another. Put the agent
  in a `Co-Authored-By:` trailer, and make the subject name the system you touched
  (`feat(core):`, `feat(storefront):`) so a stray commit is legible at a glance.
- No secrets in code or in dev environments.
- Document architecture decisions in this repo (ADR style) so future engineers and the MCP integration stay coherent.
- Pragmatic, well-supported stack — favor boring technology where it works.

## Who reports where
- **Engineering Lead** → reports to the **CEO** (in the parent workspace).
- **Specialist engineers** (Storefront, OMS, Affiliate, Interaction Tracking, MCP Integration) → report to the Engineering Lead. Storefront and catalog engineers have already been hired.
