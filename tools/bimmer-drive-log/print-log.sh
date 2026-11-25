#!/bin/sh
exec "$(command -v node || echo /usr/bin/node)" "$(dirname "$0")/print-log.js"
