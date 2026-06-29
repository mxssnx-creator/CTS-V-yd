#!/usr/bin/env bash
set -euo pipefail

# Install/authenticate GitHub CLI and keep the repository origin pointed at the
# requested GitHub repository. Designed for ephemeral CI/dev containers.
#
# Configure the target repository with one of:
#   GITHUB_REPOSITORY=OWNER/REPO
#   GITHUB_REMOTE_URL=https://github.com/OWNER/REPO.git
#   scripts/setup-github-cli.sh OWNER/REPO

ensure_github_cli() {
  if command -v gh >/dev/null 2>&1; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y -qq
    apt-get install -y -qq gh
    return 0
  fi

  echo "GitHub CLI (gh) not found and no supported package manager available." >&2
  return 1
}

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

configure_origin() {
  local remote_url="$1"

  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "${remote_url}"
  else
    git remote add origin "${remote_url}"
  fi
}

ensure_github_cli

if [ -n "${GITHUB_TOKEN:-}" ]; then
  github_token="${GITHUB_TOKEN}"
  unset GITHUB_TOKEN

  echo "${github_token}" | gh auth login --with-token
  gh auth setup-git
fi

remote_url="$(resolve_remote_url "${1:-}")"
configure_origin "${remote_url}"
