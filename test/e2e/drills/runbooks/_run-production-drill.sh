#!/bin/sh
set -eu

focus="${1:-}"
repository_root="$(git rev-parse --show-toplevel)"
source_revision="$(git -C "$repository_root" rev-parse HEAD)"
evidence_directory="${DRILL_EVIDENCE_DIRECTORY:-temp/production-drills}"

case "$focus" in
  ""|backup_fresh_volume_restore|binding_switch_drain|key_rotation|migration_application_rollback|orphan_repair|pg_boss_wakeup_repair|retention_legal_hold) ;;
  *)
    printf '%s\n' "Unknown production drill focus: $focus" >&2
    exit 2
    ;;
esac

docker info >/dev/null
docker compose \
  -f "$repository_root/test/e2e/drills/infrastructure/compose.production-drills.yaml" \
  config --quiet

corepack pnpm --dir "$repository_root" --filter @mail-edge/production-drills build

set -- \
  --confirm ephemeral-only \
  --source-revision "$source_revision" \
  --evidence-directory "$evidence_directory"
if [ -n "$focus" ]; then
  set -- "$@" --focus "$focus"
fi

node "$repository_root/test/e2e/drills/dist/run-drills.js" "$@"
