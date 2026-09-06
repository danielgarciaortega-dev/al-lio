#!/usr/bin/env bash

# Fail-closed validation for the only Docker Compose changes that a routine
# production release may cross automatically: approved environment additions
# and exact, pre-approved removals under the existing web or Radar services.
# Removal approvals use service|destination_key|source_variable|exact_default.
# They are plain data supplied by the caller and are never sourced or evaluated.

compose_env_guard_error=""
allowed_compose_env_mappings=()
allowed_compose_env_lines=()
allowed_compose_env_removals=()
allowed_compose_env_removal_lines=()
staged_compose_env_removal_approvals=()
consumed_compose_env_removal_approvals=()
revoked_compose_env_removal_approvals=()

compose_env_guard_reject() {
  compose_env_guard_error="$1"
  return 1
}

extract_service_environment() {
  local repository="$1"
  local sha="$2"
  local compose_file="$3"
  local service="$4"

  git -C "$repository" show "$sha:$compose_file" |
    awk -v wanted_service="$service" '
      $0 == "  " wanted_service ":" { in_service = 1; next }
      in_service && /^  [^ ]/ { in_service = 0; in_environment = 0 }
      in_service && /^    environment:$/ { in_environment = 1; next }
      in_service && in_environment && /^    [^ ]/ { in_environment = 0 }
      in_service && in_environment && /^      [A-Z][A-Z0-9_]*:/ { print }
    '
}

validate_unique_environment_keys() {
  local environment="$1"

  awk -F: '
    {
      key = $1
      sub(/^ +/, "", key)
      seen[key]++
      if (seen[key] > 1) exit 1
    }
  ' <<< "$environment"
}

environment_line_for_key() {
  local environment="$1"
  local key="$2"

  grep -E "^      ${key}:" <<< "$environment" || true
}

validate_new_environment_mapping() {
  local service="$1"
  local line="$2"
  local mapping_pattern='^      ([A-Z][A-Z0-9_]*): \$\{([A-Z][A-Z0-9_]*):-([-A-Za-z0-9_.,:/+]*)\}$'
  local key=""
  local source_key=""
  local expected_source_key=""

  [[ "$line" =~ $mapping_pattern ]] || return 1
  key="${BASH_REMATCH[1]}"
  source_key="${BASH_REMATCH[2]}"

  case "$service" in
    al_lio_web)
      [[ "$key" =~ ^AL_LIO_[A-Z0-9_]+$ ]] || return 1
      [[ "$source_key" == "$key" ]] || return 1
      ;;
    al_lio_radar)
      case "$key" in
        AL_LIO_DELIVERY_* | AUTONOMOUS_* | DAILY_PUBLICATION_* | WEB_DISCOVERY_* | LEARNING_* | YOUTUBE_* | JOB_RADAR_* | DISCOVERY_* | RETENTION_* | OPENAI_API_KEY) ;;
        *) return 1 ;;
      esac

      if [[ "$key" == AL_LIO_* ]]; then
        expected_source_key="AL_LIO_RADAR_${key#AL_LIO_}"
      else
        expected_source_key="AL_LIO_RADAR_${key}"
      fi
      [[ "$source_key" == "$expected_source_key" ]] || return 1
      ;;
    *)
      return 1
      ;;
  esac
}

approval_record_line() {
  local key="$1"
  local source_key="$2"
  local default_value="$3"

  printf '      %s: ${%s:-%s}' "$key" "$source_key" "$default_value"
}

validate_removal_approval_data() {
  local approval_data="$1"
  local web_environment="$2"
  local radar_environment="$3"
  local label="$4"
  local record=""
  local separators=""
  local service=""
  local key=""
  local source_key=""
  local default_value=""
  local expected_line=""
  local service_environment=""
  local match_count=0
  local approval_id=""
  declare -A seen_approvals=()

  while IFS= read -r record || [[ -n "$record" ]]; do
    [[ -z "$record" || "$record" == \#* ]] && continue

    separators="${record//[!|]/}"
    [[ "${#separators}" -eq 3 ]] ||
      compose_env_guard_reject "$label removal approval must contain exactly four pipe-delimited fields: $record" || return 1

    IFS='|' read -r service key source_key default_value <<< "$record"
    case "$service" in
      al_lio_web) service_environment="$web_environment" ;;
      al_lio_radar) service_environment="$radar_environment" ;;
      *) compose_env_guard_reject "$label removal approval names an unsupported service: $service" || return 1 ;;
    esac
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] ||
      compose_env_guard_reject "$label removal approval has an invalid destination key: $record" || return 1
    [[ "$source_key" =~ ^[A-Z][A-Z0-9_]*$ ]] ||
      compose_env_guard_reject "$label removal approval has an invalid source key: $record" || return 1
    [[ "$default_value" =~ ^[-A-Za-z0-9_.,:/+]*$ ]] ||
      compose_env_guard_reject "$label removal approval has an unsupported default: $record" || return 1

    approval_id="$service:$key"
    [[ -z "${seen_approvals[$approval_id]:-}" ]] ||
      compose_env_guard_reject "$label removal approval is duplicated: $approval_id" || return 1
    seen_approvals["$approval_id"]=1

    expected_line="$(approval_record_line "$key" "$source_key" "$default_value")"
    match_count="$(grep -Fxc -- "$expected_line" <<< "$service_environment" || true)"
    [[ "$match_count" -eq 1 ]] ||
      compose_env_guard_reject "$label removal approval does not match exactly one current mapping: $approval_id" || return 1
  done <<< "$approval_data"
}

removal_is_approved() {
  local approval_data="$1"
  local wanted_service="$2"
  local wanted_line="$3"
  local record=""
  local service=""
  local key=""
  local source_key=""
  local default_value=""
  local approved_line=""

  while IFS= read -r record || [[ -n "$record" ]]; do
    [[ -z "$record" || "$record" == \#* ]] && continue
    IFS='|' read -r service key source_key default_value <<< "$record"
    approved_line="$(approval_record_line "$key" "$source_key" "$default_value")"
    if [[ "$service" == "$wanted_service" && "$approved_line" == "$wanted_line" ]]; then
      return 0
    fi
  done <<< "$approval_data"
  return 1
}

classify_approval_transition() {
  local current_approval_data="$1"
  local candidate_approval_data="$2"
  local current_web_environment="$3"
  local current_radar_environment="$4"
  local candidate_web_environment="$5"
  local candidate_radar_environment="$6"
  local record=""
  local service=""
  local key=""
  local source_key=""
  local default_value=""
  local expected_line=""
  local current_environment=""
  local candidate_environment=""
  local candidate_line=""
  local current_records=()
  local candidate_records=()

  while IFS= read -r record || [[ -n "$record" ]]; do
    [[ -z "$record" || "$record" == \#* ]] && continue
    current_records+=("$record")
  done <<< "$current_approval_data"
  record=""
  while IFS= read -r record || [[ -n "$record" ]]; do
    [[ -z "$record" || "$record" == \#* ]] && continue
    candidate_records+=("$record")
  done <<< "$candidate_approval_data"

  if [[ "${#current_records[@]}" -gt 0 && "${#candidate_records[@]}" -gt 0 ]]; then
    compose_env_guard_reject "Current release has staged removal approvals, so candidate must contain no active approval; found: ${candidate_records[0]}" || return 1
  fi

  if [[ "${#current_records[@]}" -eq 0 ]]; then
    for record in "${candidate_records[@]}"; do
      IFS='|' read -r service key source_key default_value <<< "$record"
      case "$service" in
        al_lio_web)
          current_environment="$current_web_environment"
          candidate_environment="$candidate_web_environment"
          ;;
        al_lio_radar)
          current_environment="$current_radar_environment"
          candidate_environment="$candidate_radar_environment"
          ;;
      esac
      expected_line="$(approval_record_line "$key" "$source_key" "$default_value")"
      [[ "$(grep -Fxc -- "$expected_line" <<< "$current_environment" || true)" -eq 1 ]] ||
        compose_env_guard_reject "Candidate tried to stage an approval for a mapping not present unchanged in current Compose: $record" || return 1
      [[ "$(grep -Fxc -- "$expected_line" <<< "$candidate_environment" || true)" -eq 1 ]] ||
        compose_env_guard_reject "Candidate tried to stage an approval for a mapping not present unchanged in candidate Compose: $record" || return 1
      staged_compose_env_removal_approvals+=("$record")
    done
    return 0
  fi

  for record in "${current_records[@]}"; do
    IFS='|' read -r service key source_key default_value <<< "$record"
    case "$service" in
      al_lio_web) candidate_environment="$candidate_web_environment" ;;
      al_lio_radar) candidate_environment="$candidate_radar_environment" ;;
    esac
    expected_line="$(approval_record_line "$key" "$source_key" "$default_value")"
    candidate_line="$(environment_line_for_key "$candidate_environment" "$key")"
    if [[ "$candidate_line" == "$expected_line" ]]; then
      revoked_compose_env_removal_approvals+=("$record")
    elif [[ -z "$candidate_line" ]]; then
      consumed_compose_env_removal_approvals+=("$record")
    else
      compose_env_guard_reject "Candidate modified the mapping covered by a staged current approval instead of consuming or revoking it: $record" || return 1
    fi
  done
}

validate_compose_env_transition() {
  local repository="$1"
  local current_sha="$2"
  local candidate_sha="$3"
  local compose_file="$4"
  local current_approval_data="$5"
  local candidate_approval_data="$6"
  local change_lines=""
  local line=""
  local service=""
  local other_service=""
  local key=""
  local current_line=""
  local candidate_line=""
  local other_current_line=""
  local other_candidate_line=""
  local change_count=0
  local approved_change_count=0
  local changed_line_count=0
  local candidate_approval_count=0
  local metadata_changes=""
  local index=0
  declare -A current_environments=()
  declare -A candidate_environments=()

  compose_env_guard_error=""
  allowed_compose_env_mappings=()
  allowed_compose_env_lines=()
  allowed_compose_env_removals=()
  allowed_compose_env_removal_lines=()
  staged_compose_env_removal_approvals=()
  consumed_compose_env_removal_approvals=()
  revoked_compose_env_removal_approvals=()

  for service in al_lio_web al_lio_radar; do
    if ! current_environments["$service"]="$(extract_service_environment "$repository" "$current_sha" "$compose_file" "$service")"; then
      compose_env_guard_reject "Cannot read $service environment from current Compose." || return 1
    fi
    if ! candidate_environments["$service"]="$(extract_service_environment "$repository" "$candidate_sha" "$compose_file" "$service")"; then
      compose_env_guard_reject "Cannot read $service environment from candidate Compose." || return 1
    fi
    [[ -n "${current_environments[$service]}" && -n "${candidate_environments[$service]}" ]] ||
      compose_env_guard_reject "Required environment block is missing for $service." || return 1
    validate_unique_environment_keys "${current_environments[$service]}" ||
      compose_env_guard_reject "Current Compose has duplicate environment keys in $service." || return 1
    validate_unique_environment_keys "${candidate_environments[$service]}" ||
      compose_env_guard_reject "Candidate Compose has duplicate environment keys in $service." || return 1
  done

  validate_removal_approval_data \
    "$current_approval_data" \
    "${current_environments[al_lio_web]}" \
    "${current_environments[al_lio_radar]}" \
    "Current release" || return 1
  validate_removal_approval_data \
    "$candidate_approval_data" \
    "${candidate_environments[al_lio_web]}" \
    "${candidate_environments[al_lio_radar]}" \
    "Candidate release" || return 1
  classify_approval_transition \
    "$current_approval_data" \
    "$candidate_approval_data" \
    "${current_environments[al_lio_web]}" \
    "${current_environments[al_lio_radar]}" \
    "${candidate_environments[al_lio_web]}" \
    "${candidate_environments[al_lio_radar]}" || return 1

  metadata_changes="$(git -C "$repository" diff --summary "$current_sha" "$candidate_sha" -- "$compose_file")"
  [[ -z "$metadata_changes" ]] ||
    compose_env_guard_reject "Compose file metadata or mode changed: $metadata_changes" || return 1

  change_lines="$(
    git -C "$repository" diff --no-ext-diff --unified=0 "$current_sha" "$candidate_sha" -- "$compose_file" |
      awk '!/^--- / && !/^\+\+\+ / && /^[+-]/ { print }'
  )"
  [[ -n "$change_lines" ]] || return 0

  while IFS= read -r line; do
    [[ "$line" == +* || "$line" == -* ]] ||
      compose_env_guard_reject "Compose diff contains an unsupported change: $line" || return 1
    change_count=$((change_count + 1))
  done <<< "$change_lines"

  for service in al_lio_web al_lio_radar; do
    if [[ "$service" == "al_lio_web" ]]; then other_service="al_lio_radar"; else other_service="al_lio_web"; fi

    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      key="${line#      }"
      key="${key%%:*}"
      candidate_line="$(environment_line_for_key "${candidate_environments[$service]}" "$key")"
      if [[ -n "$candidate_line" ]]; then
        [[ "$candidate_line" == "$line" ]] ||
          compose_env_guard_reject "Environment mapping was modified in $service: $key" || return 1
        continue
      fi

      other_current_line="$(environment_line_for_key "${current_environments[$other_service]}" "$key")"
      other_candidate_line="$(environment_line_for_key "${candidate_environments[$other_service]}" "$key")"
      if [[ -z "$other_current_line" && -n "$other_candidate_line" ]]; then
        compose_env_guard_reject "Environment mapping changed service: $key" || return 1
      fi
      removal_is_approved "$current_approval_data" "$service" "$line" ||
        compose_env_guard_reject "Environment mapping removal is not approved by the current release: $service:$key" || return 1
      allowed_compose_env_removals+=("$service:$key")
      allowed_compose_env_removal_lines+=("$line")
    done <<< "${current_environments[$service]}"

    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      key="${line#      }"
      key="${key%%:*}"
      current_line="$(environment_line_for_key "${current_environments[$service]}" "$key")"
      [[ -z "$current_line" ]] || continue

      other_current_line="$(environment_line_for_key "${current_environments[$other_service]}" "$key")"
      other_candidate_line="$(environment_line_for_key "${candidate_environments[$other_service]}" "$key")"
      if [[ -n "$other_current_line" && -z "$other_candidate_line" ]]; then
        compose_env_guard_reject "Environment mapping changed service: $key" || return 1
      fi
      validate_new_environment_mapping "$service" "$line" ||
        compose_env_guard_reject "Environment mapping addition is not permitted: $service:$key" || return 1
      allowed_compose_env_mappings+=("$service:$key")
      allowed_compose_env_lines+=("$line")
    done <<< "${candidate_environments[$service]}"
  done

  if [[ "${#allowed_compose_env_removals[@]}" -gt 0 && "${#allowed_compose_env_mappings[@]}" -gt 0 ]]; then
    compose_env_guard_reject "A removal transition cannot also add an environment mapping." || return 1
  fi
  if [[ "${#allowed_compose_env_removals[@]}" -gt 0 ]]; then
    candidate_approval_count="$(grep -Evc '^[[:space:]]*(#|$)' <<< "$candidate_approval_data" || true)"
    [[ "$candidate_approval_count" -eq 0 ]] ||
      compose_env_guard_reject "A candidate consuming a removal approval must contain no reusable removal approvals." || return 1
  fi

  approved_change_count=$((${#allowed_compose_env_mappings[@]} + ${#allowed_compose_env_removals[@]}))
  [[ "$approved_change_count" -gt 0 && "$change_count" -eq "$approved_change_count" ]] ||
    compose_env_guard_reject "Compose diff contains a structural, reordered, or otherwise unclassified change." || return 1

  for ((index = 0; index < ${#allowed_compose_env_lines[@]}; index++)); do
    changed_line_count="$(grep -Fxc -- "+${allowed_compose_env_lines[$index]}" <<< "$change_lines" || true)"
    [[ "$changed_line_count" -eq 1 ]] ||
      compose_env_guard_reject "Approved addition is not represented exactly once in the raw Compose diff." || return 1
  done
  for ((index = 0; index < ${#allowed_compose_env_removal_lines[@]}; index++)); do
    changed_line_count="$(grep -Fxc -- "-${allowed_compose_env_removal_lines[$index]}" <<< "$change_lines" || true)"
    [[ "$changed_line_count" -eq 1 ]] ||
      compose_env_guard_reject "Approved removal is not represented exactly once in the raw Compose diff." || return 1
  done
}
