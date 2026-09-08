#!/usr/bin/env bash

# Verifies that a release worktree contains only the candidate Git content and
# its one required ignored private file. The caller decides how to report the
# error so this can be shared by preparation and deployment.

release_worktree_integrity_error=""

trusted_git() {
  local repository_dir="$1"
  local trusted_git_binary=""
  shift

  if [[ -x /usr/bin/git ]]; then
    trusted_git_binary=/usr/bin/git
  elif [[ -x /mingw64/bin/git.exe ]]; then
    # Git for Windows exposes its trusted installation binary here to Git Bash.
    trusted_git_binary=/mingw64/bin/git.exe
  else
    return 127
  fi

  /usr/bin/env -i \
    HOME=/nonexistent \
    PATH=/usr/bin:/bin:/mingw64/bin \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_SYSTEM=/dev/null \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_ATTR_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 \
    GIT_GRAFT_FILE=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false \
    SSH_ASKPASS=/bin/false \
    GIT_OPTIONAL_LOCKS=0 \
    "$trusted_git_binary" --no-replace-objects \
      --git-dir="$repository_dir/.git" "$@"
}

validate_release_commit_identity() {
  local repository_dir="$1"
  local expected_sha="$2"
  local canonical_repository_dir=""
  local canonical_repository_git_dir=""
  local resolved_sha=""
  local object_type=""

  release_worktree_integrity_error=""

  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
    release_worktree_integrity_error="Release SHA must be exactly 40 lowercase hexadecimal characters."
    return 1
  }
  [[ "$repository_dir" == /* && -d "$repository_dir" && ! -L "$repository_dir" &&
    -d "$repository_dir/.git" && ! -L "$repository_dir/.git" ]] || {
    release_worktree_integrity_error="Canonical repository Git directory is unavailable: $repository_dir/.git"
    return 1
  }
  canonical_repository_dir="$(readlink -f -- "$repository_dir")" || {
    release_worktree_integrity_error="Cannot resolve the canonical repository path: $repository_dir"
    return 1
  }
  canonical_repository_git_dir="$(readlink -f -- "$repository_dir/.git")" || {
    release_worktree_integrity_error="Cannot resolve the canonical repository Git directory: $repository_dir/.git"
    return 1
  }
  [[ "$canonical_repository_dir" == "$repository_dir" &&
    "$canonical_repository_git_dir" == "$repository_dir/.git" ]] || {
    release_worktree_integrity_error="Repository path is not canonical: $repository_dir"
    return 1
  }

  resolved_sha="$(
    trusted_git "$repository_dir" rev-parse --verify "$expected_sha^{object}" 2>/dev/null
  )" || {
    release_worktree_integrity_error="Release SHA does not resolve in the canonical repository: $expected_sha"
    return 1
  }
  [[ "$resolved_sha" == "$expected_sha" ]] || {
    release_worktree_integrity_error="Canonical repository resolved a different release object: $resolved_sha"
    return 1
  }

  object_type="$(trusted_git "$repository_dir" cat-file -t "$expected_sha" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot read release object type from the canonical repository: $expected_sha"
    return 1
  }
  [[ "$object_type" == commit ]] || {
    release_worktree_integrity_error="Release object is not a commit: $expected_sha ($object_type)"
    return 1
  }
}

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
      # Public diagnostic state is read by callers after this sourced function returns.
      # shellcheck disable=SC2034
      release_worktree_integrity_error="Release .env is not ignored by the candidate Git tree: $worktree/.env"
      return 1
    }
  fi
}
