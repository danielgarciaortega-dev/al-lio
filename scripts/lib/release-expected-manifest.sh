#!/usr/bin/env bash

# Builds the expected physical release manifest from an exact canonical commit.
# The caller must source release-worktree-integrity.sh first so trusted_git and
# validate_release_commit_identity are available under the frozen #469 contract.

: "${release_worktree_integrity_error:=}"

validate_expected_release_manifest_path() {
  local path="$1"

  release_worktree_integrity_error=""

  [[ -n "$path" ]] || {
    release_worktree_integrity_error="Candidate tree contains an empty path."
    return 1
  }
  [[ "$path" != /* ]] || {
    release_worktree_integrity_error="Candidate tree path must be relative: $path"
    return 1
  }
  case "/$path/" in
    *"/./"*|*"/../"*)
      release_worktree_integrity_error="Candidate tree path contains a forbidden dot component: $path"
      return 1
      ;;
  esac
  case "$path" in
    .env)
      release_worktree_integrity_error="Candidate tree must not track the private root .env file."
      return 1
      ;;
    .git|.git/*)
      release_worktree_integrity_error="Candidate tree must not track release Git metadata: $path"
      return 1
      ;;
  esac
}

build_expected_release_manifest() {
  local repository_dir="$1"
  local expected_sha="$2"
  local tree_fd=""
  local tree_pid=""
  local tree_status=0
  local record=""
  local metadata=""
  local path=""
  local mode=""
  local object_type=""
  local object_id=""
  local extra_metadata=""
  local parent=""
  local parse_error=""
  local trusted_utility=""
  local -a manifest_records=()

  release_worktree_integrity_error=""

  [[ "$(type -t trusted_git 2>/dev/null || true)" == function &&
    "$(type -t validate_release_commit_identity 2>/dev/null || true)" == function ]] || {
    release_worktree_integrity_error="Expected-manifest builder requires the trusted release-integrity primitives."
    return 1
  }
  for trusted_utility in /usr/bin/sort; do
    [[ -x "$trusted_utility" ]] || {
      release_worktree_integrity_error="Required trusted manifest utility is unavailable: $trusted_utility"
      return 1
    }
  done

  validate_release_commit_identity "$repository_dir" "$expected_sha" || return 1

  exec {tree_fd}< <(
    trusted_git "$repository_dir" ls-tree -r -z --full-tree "$expected_sha"
  )
  tree_pid=$!

  while IFS= read -r -d '' record <&"$tree_fd"; do
    if [[ "$record" != *$'\t'* ]]; then
      parse_error="Candidate tree record is missing the metadata/path separator."
      break
    fi

    metadata="${record%%$'\t'*}"
    path="${record#*$'\t'}"
    mode=""
    object_type=""
    object_id=""
    extra_metadata=""
    IFS=' ' builtin read -r mode object_type object_id extra_metadata <<< "$metadata"

    if [[ -z "$mode" || -z "$object_type" || -z "$object_id" ||
      -n "$extra_metadata" || "$metadata" != "$mode $object_type $object_id" ]]; then
      parse_error="Candidate tree record has invalid metadata: $metadata"
      break
    fi
    if [[ ! "$object_id" =~ ^[0-9a-f]{40}$ ]]; then
      parse_error="Candidate tree object ID is not a 40-character lowercase SHA-1 object: $object_id"
      break
    fi
    if [[ "$object_type" != blob || ( "$mode" != 100644 && "$mode" != 100755 ) ]]; then
      parse_error="Candidate tree entry uses an unsupported mode/type: $mode $object_type $path"
      break
    fi
    if ! validate_expected_release_manifest_path "$path"; then
      parse_error="$release_worktree_integrity_error"
      break
    fi

    manifest_records+=("F"$'\t'"$mode"$'\t'"$object_id"$'\t'"$path")

    parent="${path%/*}"
    while [[ "$parent" != "$path" && -n "$parent" ]]; do
      manifest_records+=("D"$'\t'"040000"$'\t'"-"$'\t'"$parent")
      [[ "$parent" == */* ]] || break
      parent="${parent%/*}"
    done
  done

  exec {tree_fd}<&-
  wait "$tree_pid" || tree_status=$?

  if [[ -n "$parse_error" ]]; then
    release_worktree_integrity_error="$parse_error"
    return 1
  fi
  [[ "$tree_status" -eq 0 ]] || {
    release_worktree_integrity_error="Cannot enumerate the exact candidate tree from the canonical repository: $expected_sha"
    return 1
  }

  ((${#manifest_records[@]} > 0)) || return 0

  if ! builtin printf '%s\0' "${manifest_records[@]}" | LC_ALL=C /usr/bin/sort -z -u; then
    release_worktree_integrity_error="Cannot sort the expected release manifest deterministically."
    return 1
  fi
}
