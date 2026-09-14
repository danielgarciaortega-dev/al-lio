#!/usr/bin/env bash

# Verifies tracked release bytes at one point in time after physical topology
# acceptance. Concurrent mutation remains the frozen #469 TOCTOU residual.

: "${release_worktree_integrity_error:=}"

validate_release_physical_blobs() {
  local repository_dir="$1" release_dir="$2" expected_sha="$3"
  local manifest_fd="" manifest_pid="" manifest_status=0
  local record="" kind="" mode="" remainder="" expected_oid="" path="" actual_oid=""

  release_worktree_integrity_error=""
  [[ "$(type -t validate_release_physical_topology 2>/dev/null || true)" == function &&
    "$(type -t build_expected_release_manifest 2>/dev/null || true)" == function &&
    "$(type -t trusted_git 2>/dev/null || true)" == function ]] || {
    release_worktree_integrity_error="Physical blob validation requires the trusted release-integrity helpers."
    return 1
  }

  # This must complete before any tracked path is opened below.
  validate_release_physical_topology "$repository_dir" "$release_dir" "$expected_sha" || return 1

  exec {manifest_fd}< <(build_expected_release_manifest "$repository_dir" "$expected_sha")
  manifest_pid=$!
  while IFS= read -r -d '' record <&"$manifest_fd"; do
    kind="${record%%$'\t'*}"
    remainder="${record#*$'\t'}"
    mode="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    expected_oid="${remainder%%$'\t'*}"
    path="${remainder#*$'\t'}"
    [[ "$kind" == D ]] && continue
    [[ "$kind" == F && "$mode" =~ ^100(644|755)$ && "$expected_oid" =~ ^[0-9a-f]{40}$ &&
      "$path" != "$remainder" ]] || {
      release_worktree_integrity_error="Expected release manifest contains an invalid blob record."
      break
    }
    actual_oid="$(trusted_git "$repository_dir" hash-object --no-filters --stdin < "$release_dir/$path")" || {
      release_worktree_integrity_error="Cannot hash tracked release bytes: $path"
      break
    }
    [[ "$actual_oid" == "$expected_oid" ]] || {
      release_worktree_integrity_error="Tracked release bytes do not match the canonical candidate blob: $path"
      break
    }
  done
  exec {manifest_fd}<&-
  wait "$manifest_pid" || manifest_status=$?
  [[ -z "$release_worktree_integrity_error" && "$manifest_status" -eq 0 ]] || {
    [[ -n "$release_worktree_integrity_error" ]] ||
      release_worktree_integrity_error="Cannot enumerate canonical candidate blobs."
    return 1
  }
}
