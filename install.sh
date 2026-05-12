#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/Ramiro-Ribeiro/skills"
DEST="${HOME}/.claude/skills"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      DEST="${2%/}/.claude/skills"
      shift 2
      ;;
    --dest)
      DEST="$2"
      shift 2
      ;;
    *)
      echo "Usage: install.sh [--project <project-root>] [--dest <path>]" >&2
      exit 1
      ;;
  esac
done

echo ""
echo "  Claude Code Skills Installer"
echo "  ${REPO}"
echo ""

if command -v git &>/dev/null; then
  git clone --depth=1 --quiet "$REPO.git" "$TMP/repo"
else
  echo "  ERROR: git not found. Install git and retry." >&2
  exit 1
fi

SKILLS_SRC="$TMP/repo/skills"

if [ ! -d "$SKILLS_SRC" ]; then
  echo "  ERROR: skills/ directory not found in repo." >&2
  exit 1
fi

mkdir -p "$DEST"

installed=0
for skill_dir in "$SKILLS_SRC"/*/; do
  skill="$(basename "$skill_dir")"
  dest_skill="$DEST/$skill"

  if [ -d "$dest_skill" ]; then
    echo "  ~ updated   $skill"
  else
    echo "  + installed $skill"
  fi

  cp -r "$skill_dir" "$dest_skill"
  installed=$((installed + 1))
done

echo ""
echo "  Done! ${installed} skill(s) installed to:"
echo "  ${DEST}"
echo ""
echo "  Restart Claude Code to load the new skills."
echo ""
