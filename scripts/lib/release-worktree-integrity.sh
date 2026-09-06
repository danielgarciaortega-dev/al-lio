#!/usr/bin/env bash

# Verifies that a release worktree contains only the candidate Git content and
# its one required ignored private file. The caller decides how to report the
# error so this can be shared by preparation and deployment.

release_worktree_integrity_error=""

validate_release_worktree_integrity() {
  local worktree="$1"
  local expected_sha="$2"
  local tracked_or_untracked=""
  local ignored_entries=""
  local entry=""

  release_worktree_integrity_error=""
  [[ "$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)" == "$expected_sha" ]] || {
    release_worktree_integrity_error="Release worktree HEAD does not match the candidate SHA: $worktree"
    return 1
  }

  tracked_or_untracked="$(git -C "$worktree" status --porcelain --untracked-files=all)" || {
    release_worktree_integrity_error="Cannot inspect tracked and untracked release files: $worktree"
    return 1
  }
  [[ -z "$tracked_or_untracked" ]] || {
    release_worktree_integrity_error="Release worktree contains unexpected tracked or untracked files: $tracked_or_untracked"
    return 1
  }

  ignored_entries="$(git -C "$worktree" status --porcelain --ignored --untracked-files=all)" || {
    release_worktree_integrity_error="Cannot inspect ignored release files: $worktree"
    return 1
  }
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" ]] && continue
    [[ "$entry" == "!! .env" ]] || {
      release_worktree_integrity_error="Release worktree contains an unexpected ignored file: $entry"
      return 1
    }
  done <<< "$ignored_entries"

  if [[ -e "$worktree/.env" || -L "$worktree/.env" ]]; then
    [[ -f "$worktree/.env" && ! -L "$worktree/.env" ]] || {
      release_worktree_integrity_error="Release .env must be a regular non-symlink file: $worktree/.env"
      return 1
    }
    git -C "$worktree" check-ignore -q -- .env || {
      release_worktree_integrity_error="Release .env is not ignored by the candidate Git tree: $worktree/.env"
      return 1
    }
  fi
}
