#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/validate-production-transition.sh <current-sha> <candidate-sha> [main-ref]

Validates the repository's single fail-closed production transition policy.
It does not connect to production or modify Git, Docker, or a database.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

[[ "$#" -ge 2 && "$#" -le 3 ]] || {
  usage >&2
  exit 2
}

repository_dir="${AL_LIO_REPOSITORY_DIR:-$(pwd)}"
cli_current_sha="$1"
cli_candidate_sha="$2"
cli_main_ref="${3:-origin/main}"

# shellcheck source=scripts/lib/production-transition-policy.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/production-transition-policy.sh"

if ! validate_production_transition "$repository_dir" "$cli_current_sha" "$cli_candidate_sha" "$cli_main_ref"; then
  printf 'ERROR: %s\n' "$production_transition_error" >&2
  exit 1
fi

print_production_transition_summary "$cli_current_sha" "$cli_candidate_sha"
