#!/usr/bin/env bash

# Validates release filesystem topology without consulting release-local Git.
# Byte/OID equality is intentionally deferred to the #455 boundary.

: "${release_worktree_integrity_error:=}"

declare -a release_expected_topology_records=()
declare -a release_actual_topology_records=()

inspect_release_path() {
  local path="$1"
  local label="$2"
  local required_type="$3"
  local required_mode="$4"
  local required_links="$5"
  local expected_owner="$6"
  local expected_group="$7"
  local metadata=""
  local actual_type=""
  local actual_mode=""
  local actual_owner=""
  local actual_group=""
  local actual_links=""

  metadata="$(LC_ALL=C /usr/bin/stat -c '%F|%a|%u|%g|%h' -- "$path" 2>/dev/null)" || {
    release_worktree_integrity_error="Cannot inspect $label: $path"
    return 1
  }
  IFS='|' builtin read -r actual_type actual_mode actual_owner actual_group actual_links <<< "$metadata"
  [[ "$actual_type" == "$required_type" && "$actual_mode" == "$required_mode" &&
    "$actual_owner" == "$expected_owner" && "$actual_group" == "$expected_group" &&
    ( -z "$required_links" || "$actual_links" == "$required_links" ) ]] || {
    release_worktree_integrity_error="$label must be a $required_type with mode 0$required_mode, owner $expected_owner:$expected_group${required_links:+, and one hard link}: $path"
    return 1
  }
}

collect_expected_release_topology() {
  local repository_dir="$1"
  local expected_sha="$2"
  local manifest_fd=""
  local manifest_pid=""
  local manifest_status=0
  local record=""
  local kind=""
  local mode=""
  local remainder=""
  local object_id=""
  local path=""

  release_worktree_integrity_error=""
  release_expected_topology_records=()
  exec {manifest_fd}< <(build_expected_release_manifest "$repository_dir" "$expected_sha")
  manifest_pid=$!
  while IFS= read -r -d '' record <&"$manifest_fd"; do
    kind="${record%%$'\t'*}"
    remainder="${record#*$'\t'}"
    mode="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    object_id="${remainder%%$'\t'*}"
    path="${remainder#*$'\t'}"
    [[ "$kind" =~ ^[DF]$ && -n "$mode" && -n "$object_id" && "$path" != "$remainder" ]] || {
      release_worktree_integrity_error="Expected release manifest contains an invalid topology record."
      exec {manifest_fd}<&-
      wait "$manifest_pid" || true
      return 1
    }
    release_expected_topology_records+=("$kind"$'\t'"$mode"$'\t-\t'"$path")
  done
  exec {manifest_fd}<&-
  wait "$manifest_pid" || manifest_status=$?
  [[ "$manifest_status" -eq 0 ]] || {
    release_worktree_integrity_error="Cannot build expected topology from the canonical candidate tree."
    return 1
  }
}

collect_actual_release_topology() {
  local release_dir="$1"
  local expected_owner=""
  local expected_group=""
  local find_fd=""
  local find_pid=""
  local find_status=0
  local physical_path=""
  local relative_path=""
  local metadata=""
  local physical_type=""
  local physical_mode=""

  release_worktree_integrity_error=""
  release_actual_topology_records=()
  expected_owner="$(/usr/bin/id -u)" || return 1
  expected_group="$(/usr/bin/id -g)" || return 1
  inspect_release_path "$release_dir" "Release root" directory 755 "" "$expected_owner" "$expected_group" || return 1
  if [[ -e "$release_dir/.env" || -L "$release_dir/.env" ]]; then
    inspect_release_path "$release_dir/.env" "Release .env" "regular file" 600 1 "$expected_owner" "$expected_group" || return 1
  fi

  exec {find_fd}< <(
    /usr/bin/find -P "$release_dir" -mindepth 1 \
      \( -path "$release_dir/.git" -o -path "$release_dir/.env" \) -prune -o -print0
  )
  find_pid=$!
  while IFS= read -r -d '' physical_path <&"$find_fd"; do
    relative_path="${physical_path#"$release_dir/"}"
    metadata="$(LC_ALL=C /usr/bin/stat -c '%F|%a' -- "$physical_path" 2>/dev/null)" || {
      release_worktree_integrity_error="Cannot inspect release entry: $physical_path"
      break
    }
    physical_type="${metadata%%|*}"
    physical_mode="${metadata#*|}"
    case "$physical_type" in
      directory)
        inspect_release_path "$physical_path" "Release directory" directory 755 "" "$expected_owner" "$expected_group" || break
        release_actual_topology_records+=("D"$'\t040000\t-\t'"$relative_path")
        ;;
      "regular file")
        [[ "$physical_mode" == 644 || "$physical_mode" == 755 ]] || {
          release_worktree_integrity_error="Release file has an unsupported mode: $physical_path ($physical_mode)"
          break
        }
        inspect_release_path "$physical_path" "Release file" "regular file" "$physical_mode" 1 "$expected_owner" "$expected_group" || break
        release_actual_topology_records+=("F"$'\t'"100$physical_mode"$'\t-\t'"$relative_path")
        ;;
      *)
        release_worktree_integrity_error="Release entry has an unsupported physical type: $physical_path ($physical_type)"
        break
        ;;
    esac
  done
  exec {find_fd}<&-
  wait "$find_pid" || find_status=$?
  [[ -z "$release_worktree_integrity_error" && "$find_status" -eq 0 ]] || {
    [[ -n "$release_worktree_integrity_error" ]] || release_worktree_integrity_error="Cannot traverse the physical release tree."
    return 1
  }
}

build_actual_release_topology_manifest() {
  collect_actual_release_topology "$1" || return 1
  ((${#release_actual_topology_records[@]} > 0)) || return 0
  builtin printf '%s\0' "${release_actual_topology_records[@]}" | LC_ALL=C /usr/bin/sort -z -u
}

validate_release_physical_topology() {
  local repository_dir="$1"
  local release_dir="$2"
  local expected_sha="$3"
  local utility=""

  release_worktree_integrity_error=""
  for utility in /usr/bin/find /usr/bin/stat /usr/bin/id /usr/bin/sort /usr/bin/cmp; do
    [[ -x "$utility" ]] || {
      release_worktree_integrity_error="Required trusted topology utility is unavailable: $utility"
      return 1
    }
  done
  [[ "$(type -t build_expected_release_manifest 2>/dev/null || true)" == function &&
    "$(type -t validate_release_gitfile_linkage 2>/dev/null || true)" == function ]] || {
    release_worktree_integrity_error="Physical topology validation requires the trusted release-integrity helpers."
    return 1
  }
  validate_release_gitfile_linkage "$repository_dir" "$release_dir" || return 1
  collect_expected_release_topology "$repository_dir" "$expected_sha" || return 1
  collect_actual_release_topology "$release_dir" || return 1
  /usr/bin/cmp -s \
    <(builtin printf '%s\0' "${release_expected_topology_records[@]}" | LC_ALL=C /usr/bin/sort -z -u) \
    <(builtin printf '%s\0' "${release_actual_topology_records[@]}" | LC_ALL=C /usr/bin/sort -z -u) || {
      release_worktree_integrity_error="Physical release topology does not exactly match the canonical candidate tree."
      return 1
    }
}
