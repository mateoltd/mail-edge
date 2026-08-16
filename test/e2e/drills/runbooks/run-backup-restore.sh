#!/bin/sh
set -eu
"$(dirname "$0")/_run-production-drill.sh" backup_fresh_volume_restore
