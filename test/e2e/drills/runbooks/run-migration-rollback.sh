#!/bin/sh
set -eu
"$(dirname "$0")/_run-production-drill.sh" migration_application_rollback
