#!/usr/bin/env bash
set -euo pipefail

readonly expected_root="/home/zero/Documents/VCS/mateoltd/mail-edge"
readonly expected_branch="test/w9-section-16-7-production-scale"
readonly reviewed_base="b828793a41cacf8a214ae94423422e9c27bf1af2"
readonly qualified_source_parent="698eb3c835ac1fd6dcc5b5ced1ac86ecfb0d1d4e"
readonly protected_branch="fix/w9-qualification-reproducibility"
readonly required_cpus="8"
readonly required_memory_bytes="17179869184"
readonly minimum_free_bytes="57600000000"
readonly cpu_set="0-7"
readonly task_root_parent="/home/zero/.local/state/mail-edge-section-16.7-runtime/tasks"

fail() {
  printf 'section-16.7: %s\n' "$1" >&2
  exit 1
}

write_command() {
  local path="$1"
  shift
  {
    printf '%q ' "$@"
    printf '\n'
  } >"$path"
}

validate_task_root() {
  [[ "$(dirname -- "$1")" == "$task_root_parent" ]] \
    || fail "task root is outside the owned Section 16.7 namespace"
  [[ "$(basename -- "$1")" =~ ^mail-edge-w9-section-16\.7\.[A-Za-z0-9]+$ ]] \
    || fail "task root name is malformed"
  [[ -d "$1" && ! -L "$1" ]] || fail "task root is unavailable"
  [[ "$(stat -c '%u' "$1")" == "$(id -u)" ]] || fail "task root owner changed"
}

prepare_task_root_parent() {
  local filesystem_type
  install -d -m 700 "$task_root_parent"
  [[ -d "$task_root_parent" && ! -L "$task_root_parent" ]] \
    || fail "durable task-root parent is unavailable"
  [[ "$(stat -c '%u' "$task_root_parent")" == "$(id -u)" ]] \
    || fail "durable task-root parent is not task-owned"
  [[ "$(stat -c '%a' "$task_root_parent")" == "700" ]] \
    || fail "durable task-root parent is not owner-only"
  filesystem_type="$(stat -f -c '%T' "$task_root_parent")"
  case "$filesystem_type" in
    tmpfs | ramfs | overlayfs)
      fail "task-root parent uses a non-durable filesystem: $filesystem_type"
      ;;
  esac
}

manifest_value() {
  local manifest="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$manifest"
}

repository_preflight() {
  local receipt_directory="$1"
  local receipt_prefix="$2"
  local root branch head parent base_parent local_ref tracking_ref protected_ref
  local remote_line remote_sha remote_name remote_protected_line remote_protected_sha remote_protected_name
  root="$(git rev-parse --show-toplevel)"
  branch="$(git branch --show-current)"
  head="$(git rev-parse 'HEAD^{commit}')"
  parent="$(git rev-parse 'HEAD^1^{commit}')"
  base_parent="$(git rev-parse "${reviewed_base}^1^{commit}")"
  local_ref="$(git rev-parse "refs/heads/${expected_branch}^{commit}")"
  tracking_ref="$(git rev-parse "refs/remotes/origin/${expected_branch}^{commit}")"
  protected_ref="$(git rev-parse "refs/heads/${protected_branch}^{commit}")"
  git ls-remote --refs origin \
    >"${receipt_directory}/${receipt_prefix}-git-ls-remote-all.stdout" \
    2>"${receipt_directory}/${receipt_prefix}-git-ls-remote-all.stderr"
  rg "[[:space:]]refs/heads/${expected_branch}$" \
    "${receipt_directory}/${receipt_prefix}-git-ls-remote-all.stdout" \
    >"${receipt_directory}/${receipt_prefix}-git-ls-remote-target.stdout"
  remote_line="$(cat "${receipt_directory}/${receipt_prefix}-git-ls-remote-target.stdout")"
  read -r remote_sha remote_name <<<"$remote_line"
  remote_protected_line="$(rg "[[:space:]]refs/heads/${protected_branch}$" \
    "${receipt_directory}/${receipt_prefix}-git-ls-remote-all.stdout")"
  read -r remote_protected_sha remote_protected_name <<<"$remote_protected_line"
  [[ "$root" == "$expected_root" ]] || fail "unexpected repository root: $root"
  [[ "$branch" == "$expected_branch" ]] || fail "unexpected branch: $branch"
  [[ "$head" == "$local_ref" ]] || fail "local target ref differs from HEAD"
  [[ "$head" == "$tracking_ref" ]] || fail "tracking target ref differs from HEAD"
  [[ "$head" == "$remote_sha" ]] || fail "live remote target ref differs from HEAD"
  [[ "$remote_name" == "refs/heads/${expected_branch}" ]] \
    || fail "live remote target ref is malformed"
  [[ "$parent" == "$reviewed_base" ]] || fail "target source commit is not directly based on evidence HEAD"
  [[ "$base_parent" == "$qualified_source_parent" ]] \
    || fail "evidence HEAD qualified-source parent changed"
  [[ "$protected_ref" == "$reviewed_base" ]] || fail "protected local fix branch changed"
  [[ "$remote_protected_sha" == "$reviewed_base" ]] || fail "protected remote fix branch changed"
  [[ "$remote_protected_name" == "refs/heads/${protected_branch}" ]] \
    || fail "protected remote fix branch is malformed"
  git merge-base --is-ancestor "$reviewed_base" "$head" \
    || fail "reviewed evidence HEAD is not an ancestor"
  [[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] \
    || fail "repository is not clean"
  if git for-each-ref --format='%(refname)' | rg -q '(^|/)t3code(/|$)'; then
    fail "a prohibited t3code ref is present"
  fi
  if rg -q '(^|/)t3code(/|$)' "${receipt_directory}/${receipt_prefix}-git-ls-remote-all.stdout"; then
    fail "a prohibited remote t3code ref is present"
  fi
  if find "$root" -mindepth 1 -type d -name mail-edge -print -quit | rg -q .; then
    fail "nested mail-edge checkout detected"
  fi
  git diff --check "$reviewed_base..$head"
  {
    printf 'root=%s\n' "$root"
    printf 'branch=%s\n' "$branch"
    printf 'head=%s\n' "$head"
    printf 'parent=%s\n' "$parent"
    printf 'qualified_source_parent=%s\n' "$base_parent"
    printf 'tracking=%s\n' "$tracking_ref"
    printf 'remote=%s\n' "$remote_sha"
    printf 'protected_local=%s\n' "$protected_ref"
    printf 'protected_remote=%s\n' "$remote_protected_sha"
    printf 'status=clean\n'
    printf 'nested_checkout=absent\n'
    printf 't3code_refs=absent\n'
  } >"${receipt_directory}/${receipt_prefix}-repository-preflight.stdout"
  printf '0\n' >"${receipt_directory}/${receipt_prefix}-repository-preflight.exit-status"
}

docker_preflight() {
  local receipt_directory="$1"
  local docker_cpus docker_memory
  command -v docker >/dev/null || fail "docker is unavailable"
  docker version >"${receipt_directory}/docker-version.stdout" \
    2>"${receipt_directory}/docker-version.stderr"
  docker info >"${receipt_directory}/docker-info.stdout" \
    2>"${receipt_directory}/docker-info.stderr"
  docker_cpus="$(docker info --format '{{.NCPU}}')"
  docker_memory="$(docker info --format '{{.MemTotal}}')"
  (( docker_cpus >= required_cpus )) || fail "Docker exposes fewer than 8 CPUs"
  (( docker_memory >= required_memory_bytes )) || fail "Docker exposes less than 16 GiB"
}

tooling_digest() {
  git archive --format=tar HEAD | sha256sum | awk '{print $1}'
}

record_hashes() {
  local task_root="$1"
  local stage="$2"
  [[ "$stage" =~ ^[a-z0-9-]+$ ]] || fail "receipt ledger stage is invalid"
  (
    set -o noclobber
    find "$task_root/receipts" -maxdepth 1 -type f \
      ! -name 'receipt-ledger.*.sha256' -print0 \
      | sort -z \
      | xargs -0 sha256sum >"$task_root/receipts/receipt-ledger.${stage}.sha256"
  )
}

inspect_constraints() {
  local container="$1"
  local task_root="$2"
  local expected_image="$3"
  local receipt_name="$4"
  [[ "$receipt_name" =~ ^container\.[a-z-]+\.inspect\.json$ ]] \
    || fail "container inspection receipt name is invalid"
  [[ "$(docker inspect --format '{{.Image}}' "$container")" == "$expected_image" ]] \
    || fail "container image identity changed"
  [[ "$(docker inspect --format '{{.HostConfig.CpusetCpus}}' "$container")" == "$cpu_set" ]] \
    || fail "container cpuset changed"
  [[ "$(docker inspect --format '{{.HostConfig.Memory}}' "$container")" == "$required_memory_bytes" ]] \
    || fail "container memory limit changed"
  [[ "$(docker inspect --format '{{.HostConfig.MemorySwap}}' "$container")" == "$required_memory_bytes" ]] \
    || fail "container swap limit changed"
  [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" == "none" ]] \
    || fail "container network mode changed"
  [[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")" == "true" ]] \
    || fail "container root is writable"
  [[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" == "4096" ]] \
    || fail "container PID limit changed"
  [[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container")" == '["ALL"]' ]] \
    || fail "container capability drop changed"
  [[ "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")" == '["no-new-privileges:true"]' ]] \
    || fail "container security options changed"
  [[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}|{{.RW}}{{end}}{{end}}' "$container")" == "$task_root/storage/postgres-volume|true" ]] \
    || fail "container PostgreSQL storage mount changed"
  (
    set -o noclobber
    docker inspect "$container" >"$task_root/receipts/$receipt_name"
  )
}

prepare() {
  local task_root receipt_directory source_sha digest short image container available_bytes
  local user_spec build_status preflight_status create_status image_id qualification_shell
  local phase_started
  local -a preflight_command create_command
  prepare_task_root_parent
  task_root="$(mktemp -d "${task_root_parent}/mail-edge-w9-section-16.7.XXXXXX")"
  validate_task_root "$task_root"
  receipt_directory="$task_root/receipts"
  mkdir -p \
    "$task_root/evidence" \
    "$receipt_directory" \
    "$task_root/storage" \
    "$task_root/storage/postgres-volume"
  repository_preflight "$receipt_directory" "prepare"
  docker_preflight "$receipt_directory"
  source_sha="$(git rev-parse 'HEAD^{commit}')"
  digest="$(tooling_digest)"
  short="${digest:0:16}"
  image="mail-edge-w9-section-16-7:${short}"
  container="mail-edge-w9-section-16-7-${short}"
  available_bytes="$(df --output=avail -B1 "$task_root" | tail -n 1 | tr -d ' ')"
  (( available_bytes >= minimum_free_bytes )) \
    || fail "durable free space is below 57,600,000,000 bytes"
  user_spec="$(id -u):$(id -g)"

  {
    printf 'docker build --pull --file test/scale/Dockerfile.section-16.7 '
    printf '%q ' \
      --build-arg "BASE_SHA=${reviewed_base}" \
      --build-arg "SOURCE_SHA=${source_sha}" \
      --build-arg "TOOLING_DIGEST_SHA256=${digest}" \
      --tag "$image" .
    printf '\n'
  } >"$receipt_directory/docker-build.command"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/docker-build.started-at"
  set +e
  docker build --pull \
    --file test/scale/Dockerfile.section-16.7 \
    --build-arg "BASE_SHA=${reviewed_base}" \
    --build-arg "SOURCE_SHA=${source_sha}" \
    --build-arg "TOOLING_DIGEST_SHA256=${digest}" \
    --tag "$image" . \
    >"$receipt_directory/docker-build.stdout" \
    2>"$receipt_directory/docker-build.stderr"
  build_status=$?
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/docker-build.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$receipt_directory/docker-build.duration-milliseconds"
  printf '%s\n' "$build_status" >"$receipt_directory/docker-build.exit-status"
  if (( build_status != 0 )); then
    record_hashes "$task_root" "prepare-build-failure"
    tail -n 60 "$receipt_directory/docker-build.stderr" >&2
    fail "qualification image build failed; receipts: $receipt_directory"
  fi
  image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "image ID is malformed"
  [[ "$(docker image inspect --format '{{index .Config.Labels "mail-edge.w9.source-sha"}}' "$image")" == "$source_sha" ]] \
    || fail "image source label is incorrect"
  [[ "$(docker image inspect --format '{{index .Config.Labels "mail-edge.w9.tooling-sha256"}}' "$image")" == "$digest" ]] \
    || fail "image tooling label is incorrect"
  docker image inspect "$image" >"$receipt_directory/image.inspect.json"

  preflight_command=(
    docker run --rm
    --cpuset-cpus "$cpu_set"
    --memory "$required_memory_bytes"
    --memory-swap "$required_memory_bytes"
    --network none
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --pids-limit 4096
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1073741824
    --user "$user_spec"
    --volume "$task_root:/qualification:rw"
    --volume "$task_root/storage/postgres-volume:/var/lib/postgresql/data:rw"
    "$image_id"
    preflight-production
    --storage-directory /qualification/storage
  )
  write_command "$receipt_directory/container-preflight.command" "${preflight_command[@]}"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/container-preflight.started-at"
  set +e
  "${preflight_command[@]}" \
    >"$receipt_directory/container-preflight.stdout" \
    2>"$receipt_directory/container-preflight.stderr"
  preflight_status=$?
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/container-preflight.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$receipt_directory/container-preflight.duration-milliseconds"
  printf '%s\n' "$preflight_status" >"$receipt_directory/container-preflight.exit-status"
  if (( preflight_status != 0 )); then
    record_hashes "$task_root" "prepare-preflight-failure"
    tail -n 60 "$receipt_directory/container-preflight.stderr" >&2
    fail "constrained-container preflight failed; receipts: $receipt_directory"
  fi

  if docker container inspect "$container" >/dev/null 2>&1; then
    fail "qualification container already exists: $container"
  fi
  {
    printf '%s\n' \
      "node --enable-source-maps /opt/w9-scale/dist/cli.js qualify-production --full" \
      "  --output /qualification/evidence/section-16.7-production-qualification.v1.json" \
      "  --receipt-directory /qualification/receipts" \
      "  --storage-directory /qualification/storage" \
      "  --trace-dir /opt/w9-scale/traces" \
      "  --base-sha ${reviewed_base}" \
      "  --source-sha ${source_sha}" \
      "  --tooling-digest ${digest}" \
      "  --image-digest ${image_id}"
  } >"$receipt_directory/qualification.command"

  qualification_shell="set +e
set -C
qualification_started_milliseconds=\$(date +%s%3N)
date -u +%Y-%m-%dT%H:%M:%S.%3NZ > /qualification/receipts/qualification.started-at
node --enable-source-maps /opt/w9-scale/dist/cli.js qualify-production --full --output /qualification/evidence/section-16.7-production-qualification.v1.json --receipt-directory /qualification/receipts --storage-directory /qualification/storage --trace-dir /opt/w9-scale/traces --base-sha ${reviewed_base} --source-sha ${source_sha} --tooling-digest ${digest} --image-digest ${image_id} > /qualification/receipts/qualification.stdout 2> /qualification/receipts/qualification.stderr
qualification_status=\$?
date -u +%Y-%m-%dT%H:%M:%S.%3NZ > /qualification/receipts/qualification.finished-at
qualification_finished_milliseconds=\$(date +%s%3N)
printf '%s\\n' \"\$((qualification_finished_milliseconds - qualification_started_milliseconds))\" > /qualification/receipts/qualification.duration-milliseconds
printf '%s\\n' \"\$qualification_status\" > /qualification/receipts/qualification.exit-status
sha256sum /qualification/receipts/qualification.command /qualification/receipts/qualification.stdout /qualification/receipts/qualification.stderr /qualification/receipts/qualification.exit-status /qualification/receipts/qualification.started-at /qualification/receipts/qualification.finished-at /qualification/receipts/qualification.duration-milliseconds /qualification/evidence/section-16.7-production-qualification.v1.json > /qualification/receipts/qualification.sha256
exit \"\$qualification_status\""
  create_command=(
    docker create
    --name "$container"
    --cpuset-cpus "$cpu_set"
    --memory "$required_memory_bytes"
    --memory-swap "$required_memory_bytes"
    --network none
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --pids-limit 4096
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1073741824
    --ulimit nofile=1048576:1048576
    --user "$user_spec"
    --volume "$task_root:/qualification:rw"
    --volume "$task_root/storage/postgres-volume:/var/lib/postgresql/data:rw"
    --env "MAIL_EDGE_W9_IMAGE_DIGEST=${image_id}"
    --entrypoint /bin/sh
    "$image_id"
    -ec
    "$qualification_shell"
  )
  write_command "$receipt_directory/docker-create.command" "${create_command[@]}"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/docker-create.started-at"
  set +e
  "${create_command[@]}" \
    >"$receipt_directory/docker-create.stdout" \
    2>"$receipt_directory/docker-create.stderr"
  create_status=$?
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$receipt_directory/docker-create.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$receipt_directory/docker-create.duration-milliseconds"
  printf '%s\n' "$create_status" >"$receipt_directory/docker-create.exit-status"
  if (( create_status != 0 )); then
    record_hashes "$task_root" "prepare-create-failure"
    tail -n 60 "$receipt_directory/docker-create.stderr" >&2
    fail "qualification container creation failed; receipts: $receipt_directory"
  fi
  inspect_constraints "$container" "$task_root" "$image_id" "container.prepare.inspect.json"
  {
    printf 'task_root=%s\n' "$task_root"
    printf 'container=%s\n' "$container"
    printf 'image=%s\n' "$image"
    printf 'image_id=%s\n' "$image_id"
    printf 'tooling_sha256=%s\n' "$digest"
    printf 'source_sha=%s\n' "$source_sha"
    printf 'reviewed_base=%s\n' "$reviewed_base"
    printf 'cpu_set=%s\n' "$cpu_set"
    printf 'memory_bytes=%s\n' "$required_memory_bytes"
    printf 'minimum_free_bytes=%s\n' "$minimum_free_bytes"
    printf 'prepared_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$task_root/prepared.env"
  sha256sum "$task_root/prepared.env" >"$task_root/prepared.env.sha256"
  record_hashes "$task_root" "prepare-success"

  printf 'Section 16.7 container prepared but not started.\n'
  printf 'Task root: %s\n' "$task_root"
  printf 'Container: %s\n' "$container"
  printf 'Image: %s\n' "$image"
  printf 'Image ID: %s\n' "$image_id"
  printf 'Preflight: %s\n' "$(tail -n 1 "$receipt_directory/container-preflight.stdout")"
  printf 'Actual pass command: %q execute %q %q\n' "$0" "$container" "$task_root"
}

inspect_prepared() {
  [[ $# -eq 2 ]] || fail "inspect requires a container name and task root"
  validate_task_root "$2"
  sha256sum --check "$2/prepared.env.sha256" >/dev/null
  inspect_constraints \
    "$1" "$2" "$(manifest_value "$2/prepared.env" image_id)" \
    "container.manual.inspect.json"
  docker inspect --format \
    'name={{.Name}} status={{.State.Status}} cpuset={{.HostConfig.CpusetCpus}} memory={{.HostConfig.Memory}} memorySwap={{.HostConfig.MemorySwap}} readonly={{.HostConfig.ReadonlyRootfs}} network={{.HostConfig.NetworkMode}} image={{.Image}}' \
    "$1"
}

execute_prepared() {
  [[ $# -eq 2 ]] || fail "execute requires a container name and task root"
  local container="$1"
  local task_root="$2"
  local status start_status verify_status source_sha digest image_id user_spec phase_started
  local -a verification_command
  validate_task_root "$task_root"
  sha256sum --check "$task_root/prepared.env.sha256" >/dev/null
  [[ "$(manifest_value "$task_root/prepared.env" container)" == "$container" ]] \
    || fail "container does not match the prepared manifest"
  source_sha="$(manifest_value "$task_root/prepared.env" source_sha)"
  digest="$(manifest_value "$task_root/prepared.env" tooling_sha256)"
  image_id="$(manifest_value "$task_root/prepared.env" image_id)"
  repository_preflight "$task_root/receipts" "execute"
  inspect_constraints \
    "$container" "$task_root" "$image_id" "container.execute-before.inspect.json"
  [[ "$(docker inspect --format '{{.State.Status}}' "$container")" == "created" ]] \
    || fail "qualification container is not in created state"
  write_command "$task_root/receipts/docker-start.command" docker start --attach "$container"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$task_root/receipts/docker-start.started-at"
  set +e
  docker start --attach "$container" \
    >"$task_root/receipts/docker-start.stdout" \
    2>"$task_root/receipts/docker-start.stderr"
  start_status=$?
  status="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$task_root/receipts/docker-start.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$task_root/receipts/docker-start.duration-milliseconds"
  printf '%s\n' "$start_status" >"$task_root/receipts/docker-start-cli.exit-status"
  printf '%s\n' "$status" >"$task_root/receipts/docker-start.exit-status"
  (
    set -o noclobber
    docker inspect "$container" >"$task_root/receipts/container.after.inspect.json"
  )
  if [[ "$start_status" != "0" || "$status" != "0" ]]; then
    record_hashes "$task_root" "execute-failure"
    printf 'Section 16.7 container exit status: %s\n' "$status" >&2
    tail -n 60 "$task_root/receipts/qualification.stderr" >&2 || true
    tail -n 30 "$task_root/receipts/qualification.stdout" >&2 || true
    exit "$status"
  fi
  [[ -f "$task_root/evidence/section-16.7-production-qualification.v1.json" ]] \
    || fail "canonical production evidence is missing"
  user_spec="$(id -u):$(id -g)"
  verification_command=(
    docker run --rm
    --cpuset-cpus "$cpu_set"
    --memory "$required_memory_bytes"
    --memory-swap "$required_memory_bytes"
    --network none
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --pids-limit 4096
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1073741824
    --user "$user_spec"
    --volume "$task_root:/qualification:ro"
    --volume "$task_root/storage/postgres-volume:/var/lib/postgresql/data:ro"
    "$image_id"
    verify-production
    --input /qualification/evidence/section-16.7-production-qualification.v1.json
    --expected-base-sha "$reviewed_base"
    --expected-source-sha "$source_sha"
    --expected-tooling-digest "$digest"
    --expected-image-digest "$image_id"
    --receipt-directory /qualification/receipts
    --storage-directory /qualification/storage
    --trace-dir /opt/w9-scale/traces
  )
  write_command "$task_root/receipts/independent-verification.command" \
    "${verification_command[@]}"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ \
    >"$task_root/receipts/independent-verification.started-at"
  set +e
  "${verification_command[@]}" \
    >"$task_root/receipts/independent-verification.stdout" \
    2>"$task_root/receipts/independent-verification.stderr"
  verify_status=$?
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ \
    >"$task_root/receipts/independent-verification.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$task_root/receipts/independent-verification.duration-milliseconds"
  printf '%s\n' "$verify_status" >"$task_root/receipts/independent-verification.exit-status"
  sha256sum "$task_root/evidence/section-16.7-production-qualification.v1.json" \
    >"$task_root/evidence/section-16.7-production-qualification.v1.json.sha256"
  if (( verify_status != 0 )); then
    record_hashes "$task_root" "execute-verification-failure"
    tail -n 60 "$task_root/receipts/independent-verification.stderr" >&2
    fail "independent production evidence verification failed"
  fi
  record_hashes "$task_root" "execute-success"
  printf 'Section 16.7 container exit status: 0\n'
  tail -n 20 "$task_root/receipts/qualification.stdout"
  tail -n 20 "$task_root/receipts/independent-verification.stdout"
  printf 'Evidence: %s\n' \
    "$task_root/evidence/section-16.7-production-qualification.v1.json"
}

cleanup_container() {
  [[ $# -eq 2 ]] || fail "cleanup-container requires a container name and task root"
  local container="$1"
  local task_root="$2"
  local rm_status phase_started
  validate_task_root "$task_root"
  sha256sum --check "$task_root/prepared.env.sha256" >/dev/null
  [[ "$(manifest_value "$task_root/prepared.env" container)" == "$container" ]] \
    || fail "container does not match the prepared manifest"
  [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == "false" ]] \
    || fail "qualification container is still running"
  write_command "$task_root/receipts/docker-rm.command" docker rm "$container"
  phase_started="$(date +%s%3N)"
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$task_root/receipts/docker-rm.started-at"
  set +e
  docker rm "$container" >"$task_root/receipts/docker-rm.stdout" \
    2>"$task_root/receipts/docker-rm.stderr"
  rm_status=$?
  set -e
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$task_root/receipts/docker-rm.finished-at"
  printf '%s\n' "$(( $(date +%s%3N) - phase_started ))" \
    >"$task_root/receipts/docker-rm.duration-milliseconds"
  printf '%s\n' "$rm_status" >"$task_root/receipts/docker-rm.exit-status"
  record_hashes "$task_root" "cleanup"
  if (( rm_status != 0 )); then
    tail -n 60 "$task_root/receipts/docker-rm.stderr" >&2
    fail "qualification container cleanup failed"
  fi
}

main() {
  [[ $# -ge 1 ]] || fail "usage: $0 prepare|inspect|execute|cleanup-container"
  local command="$1"
  shift
  case "$command" in
    prepare)
      [[ $# -eq 0 ]] || fail "prepare accepts no arguments"
      prepare
      ;;
    inspect)
      inspect_prepared "$@"
      ;;
    execute)
      execute_prepared "$@"
      ;;
    cleanup-container)
      cleanup_container "$@"
      ;;
    *)
      fail "unknown command: $command"
      ;;
  esac
}

main "$@"
