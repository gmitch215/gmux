#!/usr/bin/env bash
set -euo pipefail

# Publishes the Doxygen output into gh-pages/doxygen, leaving the sibling TypeDoc set alone.
# Usage: bash doxygen.sh <short-sha>

HTML_DIR="${DOXYGEN_HTML_DIR:-build-native/docs/html}"

if [[ ! -d $HTML_DIR ]]; then
	echo "no Doxygen output at $HTML_DIR; run 'bun run docs:c' first" >&2
	exit 1
fi

# -c rather than 'git config --local': the local form writes into .git/config and stays there, so a
# run on a workstation leaves every later commit in that clone attributed to GitHub Action. This
# script did exactly that here and 39 commits carry the wrong author because of it.
commit_as=(-c "user.email=action@github.com" -c "user.name=GitHub Action")

start="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
tmpdir="$(mktemp -d)"
# the sibling script runs next and needs its own sources back, so the branch is always restored
trap 'rm -rf "$tmpdir"; git switch -f -q "$start" 2> /dev/null || true' EXIT

cp -R "$HTML_DIR/." "$tmpdir/doxygen"

if [[ ! -f docs/index.html ]]; then
	echo "docs/index.html is generated from README.md; run 'bun run docs:site' first." >&2
	exit 1
fi

# staged before the branch switch, because these only exist on the source branch
cp docs/index.html "$tmpdir/index.html"
cp docs/CNAME "$tmpdir/CNAME"

if git fetch origin gh-pages 2> /dev/null; then
	git branch --no-track -f gh-pages origin/gh-pages 2> /dev/null || true
	git switch -f gh-pages
elif git show-ref --verify --quiet refs/heads/gh-pages; then
	# the sibling script created it earlier in this same job and has not pushed yet, so reusing it
	# is what keeps both tools' output in one branch
	git switch -f gh-pages
else
	# a first deploy has nothing to branch from, so start an orphan rather than force-pushing
	git switch --orphan gh-pages
	# --orphan keeps the index, and only the index needs clearing; the working tree is left alone
	# so the sibling script's build output survives
	git rm -rq --cached . 2> /dev/null || true
fi

# only this tool's own subdirectory is replaced, so the sibling's output survives
rm -rf doxygen
cp -R "$tmpdir/doxygen" doxygen
cp "$tmpdir/index.html" index.html
# rewritten every deploy, because an orphan branch starts without it and Pages drops the domain
cp "$tmpdir/CNAME" CNAME

# scoped rather than 'git add -A': the working tree still holds source, build output and
# node_modules, and gh-pages carries no .gitignore to keep them out
git add -A -- doxygen index.html CNAME

if git diff --cached --quiet; then
	echo "No Doxygen changes to deploy."
	exit 0
fi

git "${commit_as[@]}" commit -m "Update Doxygen ($1)"
# the branch was built on origin/gh-pages, so this fast-forwards and never needs -f
git push origin gh-pages
