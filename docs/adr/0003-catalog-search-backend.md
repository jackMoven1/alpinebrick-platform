# ADR-0003 — Catalog Search Backend (Relevance Search)

**Status:** DRAFT — deferred decision, not yet scheduled. Logged 2026-06-03 as a carve-out from [ADR-0001](0001-catalog-api-contract.md).
**Owners:** `catalog-engineer` (primary), `storefront-engineer` (consumer), `engineering-lead` (approver).
**Decision maker:** **Jack** — a dedicated search engine likely locks the platform into paid infrastructure (per ADR-0001 Process step 6).

## Why this is deferred (not decided)
The v1 catalog contract (ADR-0001, ACCEPTED) ships **substring search only**: the `search` param does a case-insensitive `ILIKE %term%` across `name` + `description`, explicitly documented as "substring, not relevance-ranked." That is honest and sufficient for a small v1 catalog and required no extra infrastructure.

## What still needs deciding
- **Engine:** Postgres full-text (`tsvector`/`tsquery`, no new infra) vs. a dedicated search service (Elasticsearch / OpenSearch / Meilisearch / Typesense / Algolia).
- **Relevance & features:** ranking, typo tolerance, synonyms, faceted search + facet counts (ADR-0001 also deferred faceted category navigation — these are related), autocomplete/suggestions.
- **Index sync:** how catalog writes propagate to the index (the `catalog.product.*` events in `contracts/events/` are the natural hook).
- **Query-contract impact:** whether `search` semantics change (relevance scores, highlight fields) — would be an ADR-0001 amendment or a follow-on contract version.
- **Cost model & spend approval:** hosted (Algolia/managed OpenSearch) vs. self-run; monthly ceiling — **Jack's call.**

## Relationship to other deferred items
ADR-0001 also deferred the **faceted category tree / multi-select filtering**. If we adopt a search engine, facets and relevance are usually solved together, so scope them as one initiative.

## Next step
Revisit when catalog size or search-quality complaints justify the move off substring matching. Cheapest first step (Postgres FTS) needs no new infra and could be an interim ADR before any paid engine. No work scheduled.
