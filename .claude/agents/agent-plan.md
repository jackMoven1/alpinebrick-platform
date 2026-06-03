# ImagiBricks Agent Plan

## Purpose
This file defines the agent planning strategy for the ImagiBricks engineering workspace. It documents the agent roles, sequencing, and the first steps for hiring and creating the specialist engineer agents that will execute the platform build.

## Current state
- Existing agent: `engineering-lead`
- Workspace context: engineering planning, architecture, and repo structure decisions for the ImagiBricks platform.
- No specialist engineer agents are present yet.

## Agent roles to create
1. `storefront-engineer`
   - Build the retail website, product catalog, cart, accounts, checkout UI, and Stripe payment integration.
2. `oms-engineer`
   - Build the order management system, inventory control, fulfillment workflow, and back-office order processing.
3. `affiliate-engineer`
   - Build affiliate partner accounts, referral code tracking, flat-% commission engine, Stripe Connect payout support.
4. `tracking-engineer`
   - Build interaction tracking, analytics, event capture, and order-level affiliate attribution.
5. `mcp-integration-engineer`
   - Build the MCP connector, exposing orders, inventory, customers, affiliates, and referrals to back-office agents.

## Recommended first agent sequence
1. `storefront-engineer` — MVP website and Stripe checkout.
2. `oms-engineer` — order lifecycle and inventory foundation.
3. `tracking-engineer` — capture attribution and analytics before launch.
4. `affiliate-engineer` — affiliate referral logic and payout data.
5. `mcp-integration-engineer` — expose data to back-office MCP agents once the core models are stable.

## Planning steps
1. Confirm the engineering scope with Jack, especially the launch MVP and whether the first agent should be storefront or foundation/DevOps.
2. Decide the repo structure (monorepo vs. multi-repo) and the stack. Document this as the first architecture decision.
3. Create new agent manifests in `.claude/agents/` for the selected specialist roles.
4. Keep the `engineering-lead` agent as the architecture owner; use it to coordinate the specialist agents and review their outputs.
5. Document decisions in ADR-style files so future agents and engineers can follow the approved architecture.

## Notes
- The platform must preserve the locked engineering constraints from `CLAUDE.md`: custom web app, Stripe payments, flat-% affiliate model, order-level attribution, no secrets in code, and branch + review workflow.
- The agent plan should stay aligned with future back-office plans in the parent workspace.
