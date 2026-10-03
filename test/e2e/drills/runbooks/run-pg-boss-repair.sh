#!/bin/sh
set -eu
"$(dirname "$0")/_run-production-drill.sh" pg_boss_wakeup_repair
