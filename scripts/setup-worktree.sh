#!/bin/sh

set -eu

if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' 'error: pnpm is required to set up this worktree' >&2
  exit 1
fi

printf '%s\n' 'Installing dependencies from the frozen lockfile...'
pnpm install --frozen-lockfile

printf '%s\n' 'Building the workspace...'
pnpm build
