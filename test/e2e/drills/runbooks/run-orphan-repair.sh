#!/bin/sh
set -eu
"$(dirname "$0")/_run-production-drill.sh" orphan_repair
