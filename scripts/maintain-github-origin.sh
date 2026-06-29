#!/usr/bin/env bash
set -euo pipefail

# Ensure git origin points at the requested GitHub repository.
#
# Configure the target repository with one of:
#   GITHUB_REPOSITORY=OWNER/REPO
#   GITHUB_REMOTE_URL=https://github.com/OWNER/REPO.git
#   scripts/maintain-github-origin.sh OWNER/REPO

resolve_remote_url() {
  local repo="${1:-${GITHUB_REPOSITORY:-}}"

  if [ -n "${GITHUB_REMOTE_URL:-}" ]; then
    printf '%s\n' "${GITHUB_REMOTE_URL}"
    return 0
  fi

  if [ -n "${repo}" ]; then
    case "${repo}" in
      http://*|https://*|git@*) printf '%s\n' "${repo}" ;;
      *) printf 'https://github.com/%s.git\n' "${repo}" ;;
    esac
    return 0
  fi

  echo "Set GITHUB_REPOSITORY, GITHUB_REMOTE_URL, or pass OWNER/REPO." >&2
  return 1
}

remote_url="$(resolve_remote_url "${1:-}")"

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${remote_url}"
else
  git remote add origin "${remote_url}"
fi
