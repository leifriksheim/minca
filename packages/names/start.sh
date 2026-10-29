#!/bin/sh
# Fly mounts the volume owned by root: give it to the non-root user the base
# image provides, then run the service as that user.
set -eu
dir="${NAMES_DIR:?set NAMES_DIR}"
mkdir -p "$dir"
chown -R node:node "$dir"
exec su-exec node node server.mjs
