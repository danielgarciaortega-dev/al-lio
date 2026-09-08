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

read_release_git_metadata_line() {
  local metadata_path="$1"
  local metadata_label="$2"
  local metadata_size=""
  local byte_dump=""

  release_git_metadata_line=""
  [[ -f "$metadata_path" && ! -L "$metadata_path" ]] || {
    release_worktree_integrity_error="$metadata_label must be a regular non-symlink file: $metadata_path"
    return 1
  }
  metadata_size="$(stat -c '%s' -- "$metadata_path" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect $metadata_label size: $metadata_path"
    return 1
  }
  [[ "$metadata_size" =~ ^[0-9]+$ && "$metadata_size" -gt 0 &&
    "$metadata_size" -le 4096 ]] || {
    release_worktree_integrity_error="$metadata_label must contain between 1 and 4096 bytes: $metadata_path"
    return 1
  }

  byte_dump="$(LC_ALL=C od -An -v -tu1 -- "$metadata_path" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot read raw $metadata_label bytes: $metadata_path"
    return 1
  }
  LC_ALL=C awk '
    BEGIN { bytes = 0; line_feeds = 0; last = -1; valid = 1 }
    {
      for (field = 1; field <= NF; field++) {
        byte = $field + 0
        bytes++
        last = byte
        if (byte == 10) {
          line_feeds++
        } else if (byte < 32 || byte == 127) {
          valid = 0
        }
      }
    }
    END {
      if (bytes == 0 || line_feeds != 1 || last != 10) {
        valid = 0
      }
      exit(valid ? 0 : 1)
    }
  ' <<< "$byte_dump" || {
    release_worktree_integrity_error="$metadata_label must be exactly one control-free line with one final LF: $metadata_path"
    return 1
  }

  IFS= read -r release_git_metadata_line < "$metadata_path" || {
    release_worktree_integrity_error="Cannot parse $metadata_label: $metadata_path"
    return 1
  }
}

normalize_release_absolute_path() {
  local raw_path="$1"
  local normalized_path=""
  local windows_path=""

  if [[ "$raw_path" == /* ]]; then
    normalized_path="$raw_path"
  elif [[ "$raw_path" =~ ^[A-Za-z]:[\\/].* && -x /usr/bin/cygpath ]]; then
    normalized_path="$(/usr/bin/cygpath -u -- "$raw_path")" || return 1
  else
    return 1
  fi

  if [[ -x /usr/bin/cygpath ]]; then
    windows_path="$(/usr/bin/cygpath -w -- "$normalized_path")" || return 1
    /usr/bin/cygpath -u -- "$windows_path"
  else
    printf '%s\n' "$normalized_path"
  fi
}

validate_release_gitfile_linkage() {
  local repository_dir=""
  local release_dir=""
  local repository_git_dir=""
  local worktrees_dir=""
  local release_gitfile=""
  local canonical_path=""
  local expected_owner=""
  local expected_group=""
  local actual_mode=""
  local actual_owner=""
  local actual_group=""
  local actual_links=""
  local gitdir_line=""
  local raw_gitdir_path=""
  local linked_git_dir=""
  local worktree_name=""
  local commondir_value=""
  local linked_commondir=""
  local backpointer_value=""
  local linked_backpointer=""

  release_worktree_integrity_error=""
  repository_dir="$(normalize_release_absolute_path "$1")" || {
    release_worktree_integrity_error="Canonical repository path must be absolute: $1"
    return 1
  }
  release_dir="$(normalize_release_absolute_path "$2")" || {
    release_worktree_integrity_error="Release path must be absolute: $2"
    return 1
  }
  repository_git_dir="$repository_dir/.git"
  worktrees_dir="$repository_git_dir/worktrees"
  release_gitfile="$release_dir/.git"
  [[ "$repository_dir" == /* && -d "$repository_dir" && ! -L "$repository_dir" ]] || {
    release_worktree_integrity_error="Canonical repository directory is unavailable: $repository_dir"
    return 1
  }
  [[ "$release_dir" == /* && -d "$release_dir" && ! -L "$release_dir" ]] || {
    release_worktree_integrity_error="Release directory is unavailable or non-canonical: $release_dir"
    return 1
  }
  for canonical_path in "$repository_dir" "$repository_git_dir" "$worktrees_dir" "$release_dir"; do
    [[ -d "$canonical_path" && ! -L "$canonical_path" &&
      "$(readlink -f -- "$canonical_path" 2>/dev/null)" == "$canonical_path" ]] || {
      release_worktree_integrity_error="Required directory is unavailable, non-canonical, or traverses a symlink: $canonical_path"
      return 1
    }
  done

  [[ -f "$release_gitfile" && ! -L "$release_gitfile" ]] || {
    release_worktree_integrity_error="Release .git must be a regular non-symlink file: $release_gitfile"
    return 1
  }
  actual_mode="$(stat -c '%a' -- "$release_gitfile" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect release .git mode: $release_gitfile"
    return 1
  }
  actual_owner="$(stat -c '%u' -- "$release_gitfile" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect release .git owner: $release_gitfile"
    return 1
  }
  actual_group="$(stat -c '%g' -- "$release_gitfile" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect release .git group: $release_gitfile"
    return 1
  }
  actual_links="$(stat -c '%h' -- "$release_gitfile" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect release .git link count: $release_gitfile"
    return 1
  }
  expected_owner="$(id -u)" || {
    release_worktree_integrity_error="Cannot determine the expected release .git owner."
    return 1
  }
  expected_group="$(id -g)" || {
    release_worktree_integrity_error="Cannot determine the expected release .git group."
    return 1
  }
  [[ "$actual_mode" == 644 && "$actual_owner" == "$expected_owner" &&
    "$actual_group" == "$expected_group" && "$actual_links" == 1 ]] || {
    release_worktree_integrity_error="Release .git metadata must be mode 0644, owned by $expected_owner:$expected_group, with one hard link: $release_gitfile"
    return 1
  }

  read_release_git_metadata_line "$release_gitfile" "Release .git" || return 1
  gitdir_line="$release_git_metadata_line"
  [[ "$gitdir_line" == "gitdir: "* ]] || {
    release_worktree_integrity_error="Release .git must start with the literal prefix 'gitdir: ': $release_gitfile"
    return 1
  }
  raw_gitdir_path="${gitdir_line#gitdir: }"
  [[ -n "$raw_gitdir_path" ]] || {
    release_worktree_integrity_error="Release .git contains an empty gitdir target: $release_gitfile"
    return 1
  }
  linked_git_dir="$(normalize_release_absolute_path "$raw_gitdir_path")" || {
    release_worktree_integrity_error="Release .git target must be absolute: $raw_gitdir_path"
    return 1
  }
  [[ -d "$linked_git_dir" && ! -L "$linked_git_dir" &&
    "$(readlink -f -- "$linked_git_dir" 2>/dev/null)" == "$linked_git_dir" ]] || {
    release_worktree_integrity_error="Release gitdir target is unavailable, non-canonical, or traverses a symlink: $linked_git_dir"
    return 1
  }
  [[ "$linked_git_dir" == "$worktrees_dir/"* ]] || {
    release_worktree_integrity_error="Release gitdir target is outside the canonical worktrees directory: $linked_git_dir"
    return 1
  }
  worktree_name="${linked_git_dir#"$worktrees_dir/"}"
  [[ -n "$worktree_name" && "$worktree_name" != */* ]] || {
    release_worktree_integrity_error="Release gitdir target must be one immediate child of the canonical worktrees directory: $linked_git_dir"
    return 1
  }

  read_release_git_metadata_line "$linked_git_dir/commondir" "Linked commondir" || return 1
  commondir_value="$release_git_metadata_line"
  if linked_commondir="$(normalize_release_absolute_path "$commondir_value" 2>/dev/null)"; then
    :
  else
    linked_commondir="$linked_git_dir/$commondir_value"
  fi
  linked_commondir="$(readlink -f -- "$linked_commondir" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot resolve linked commondir: $linked_git_dir/commondir"
    return 1
  }
  [[ "$linked_commondir" == "$repository_git_dir" ]] || {
    release_worktree_integrity_error="Linked commondir does not identify the canonical repository Git directory: $linked_commondir"
    return 1
  }

  read_release_git_metadata_line "$linked_git_dir/gitdir" "Linked gitdir backpointer" || return 1
  backpointer_value="$release_git_metadata_line"
  linked_backpointer="$(normalize_release_absolute_path "$backpointer_value")" || {
    release_worktree_integrity_error="Linked gitdir backpointer must be absolute: $backpointer_value"
    return 1
  }
  [[ "$(readlink -f -- "$linked_backpointer" 2>/dev/null)" == "$release_gitfile" &&
    "$linked_backpointer" == "$release_gitfile" ]] || {
    release_worktree_integrity_error="Linked gitdir backpointer does not identify the release .git file: $linked_backpointer"
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
