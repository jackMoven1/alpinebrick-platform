#!/usr/bin/env bash
#
# Regenerate SDD task briefs verbatim from their plan.
#
# Why this exists
# ---------------
# `.superpowers/sdd/.gitignore` is `*`, so task briefs never travel with a
# commit. When a plan is amended, the briefs on disk keep the old text -- and
# the brief, not the plan, is what a worker actually executes. This has bitten
# twice:
#
#   * the dead `IB-` order-number prefix survived the ImagiBricks rename
#     (PR #14 fixed the plan; the brief kept emitting `IB-000001`)
#   * `Order.discountCents` / `OrderLine.discountCents` were added to Plan 2
#     (PR #13) but were absent from every brief, so Task 2 would have produced
#     a migration without the columns -- silently overpaying designer royalty
#     on every discounted line.
#
# Run this after ANY plan amendment. Never hand-edit a brief: the edit is
# invisible to git and will be lost the next time this runs.
#
# Usage:
#   scripts/regen-sdd-briefs.sh [path/to/plan.md]
# Defaults to the Phase 2 orders plan.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

PLAN_REL=${1:-docs/superpowers/plans/2026-07-08-phase2-orders-inventory-tax.md}

if [[ ! -f "$PLAN_REL" ]]; then
  echo "error: plan not found: $PLAN_REL" >&2
  exit 1
fi

PLAN_SLUG=$(basename "$PLAN_REL" .md)
OUT=".superpowers/sdd/$PLAN_SLUG"
mkdir -p "$OUT"

REV=$(git log -1 --format=%h -- "$PLAN_REL" 2>/dev/null || echo "uncommitted")
REVDATE=$(git log -1 --format=%ad --date=short -- "$PLAN_REL" 2>/dev/null || echo "-")
CR=$'\r'

TOTAL_LINES=$(wc -l < "$PLAN_REL")

# Section boundaries are DERIVED, never hardcoded -- hardcoded line numbers go
# stale on the next plan amendment, which is the very bug this script prevents.
# `## ` matches a level-2 heading only, because `### Task` also starts with '#'.
task_starts=()
while IFS= read -r n; do task_starts+=("$n"); done < <(grep -n '^### Task ' "$PLAN_REL" | cut -d: -f1)

h2_lines=()
while IFS= read -r n; do h2_lines+=("$n"); done < <(grep -n '^## ' "$PLAN_REL" | cut -d: -f1)

if [[ ${#task_starts[@]} -eq 0 ]]; then
  echo "error: no '### Task N:' sections found in $PLAN_REL" >&2
  exit 1
fi

# Shared context = '## Global Constraints' through the line before the first task.
ctx_start=$(grep -n '^## Global Constraints' "$PLAN_REL" | head -1 | cut -d: -f1)
if [[ -z "$ctx_start" ]]; then
  echo "error: no '## Global Constraints' section found in $PLAN_REL" >&2
  exit 1
fi
ctx_end=$(( ${task_starts[0]} - 1 ))

# Trim trailing blank / horizontal-rule lines off the context block.
while [[ $ctx_end -gt $ctx_start ]]; do
  line=$(sed -n "${ctx_end}p" "$PLAN_REL" | tr -d '\r')
  [[ -z "$line" || "$line" == "---" ]] || break
  ctx_end=$(( ctx_end - 1 ))
done

count=${#task_starts[@]}
for (( i = 0; i < count; i++ )); do
  start=${task_starts[$i]}

  # End = line before the next task, or before the next level-2 heading that
  # follows this task, or EOF.
  if (( i + 1 < count )); then
    end=$(( ${task_starts[$i + 1]} - 1 ))
  else
    end=$TOTAL_LINES
    for h in "${h2_lines[@]}"; do
      if (( h > start )); then end=$(( h - 1 )); break; fi
    done
  fi

  n=$(sed -n "${start}p" "$PLAN_REL" | sed -E 's/^### Task ([0-9]+):.*/\1/' | tr -d '\r')
  dest="$OUT/task-$n-brief.md"

  # `sed -n Xp` strips the CR from a CRLF source, so the extracted text comes out
  # LF while the printf'd header would keep its CR -- a mixed-ending file. Build
  # everything as plain LF, then normalise every line to exactly one CRLF, so the
  # brief matches the CRLF convention of the rest of this Windows checkout.
  {
    printf '<!-- GENERATED FILE - DO NOT EDIT BY HAND.\n'
    printf '     Source: %s\n' "$PLAN_REL"
    printf '     Plan revision: %s (%s)\n' "$REV" "$REVDATE"
    printf '     Regenerate with: scripts/regen-sdd-briefs.sh %s\n' "$PLAN_REL"
    printf '     A hand-edit here is invisible to git: .superpowers/sdd/ is ignored in full. -->\n'
    printf '\n'
    printf '## Plan context (verbatim from the plan - applies to every task)\n'
    printf '\n'
    sed -n "${ctx_start},${ctx_end}p" "$PLAN_REL"
    printf '\n'
    printf -- '---\n'
    printf '\n'
    sed -n "${start},${end}p" "$PLAN_REL"
  } | sed 's/\r*$/\r/' > "$dest"

  echo "wrote $dest (task $n, plan lines $start-$end)"
done

echo "done: $count brief(s) from $PLAN_REL @ $REV"
