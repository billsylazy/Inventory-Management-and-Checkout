#!/bin/sh
# Hosting platforms often mount the data volume owned by root. Make sure the
# unprivileged "node" user can write to it, then drop root before starting.
set -e
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
