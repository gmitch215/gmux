#!/usr/bin/env bash
set -euo pipefail

# Publishes the TypeDoc output into gh-pages/typedoc, leaving the sibling Doxygen set alone.
# Usage: bash typedoc.sh <short-sha>

# build-typedoc rather than typedoc: gh-pages tracks a published `typedoc/`, so a sibling script's
# `git switch -f gh-pages` would check that over the fresh build and make it tracked, and switching
# back would delete it as a file the target branch does not have. The local build directory has to be
# a name gh-pages never carries.
HTML_DIR="${TYPEDOC_HTML_DIR:-build-typedoc}"

if [[ ! -d $HTML_DIR ]]; then
	echo "no TypeDoc output at $HTML_DIR; run 'bun run docs:build' first" >&2
	exit 1
fi

# -c rather than 'git config --local', which writes into .git/config and stays there; see the same
# note in doxygen.sh
commit_as=(-c "user.email=action@github.com" -c "user.name=GitHub Action")

start="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
tmpdir="$(mktemp -d)"
# the sibling script may run next and needs its own sources back, so the branch is always restored
trap 'rm -rf "$tmpdir"; git switch -f -q "$start" 2> /dev/null || true' EXIT

cp -R "$HTML_DIR/." "$tmpdir/typedoc"

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
rm -rf typedoc
cp -R "$tmpdir/typedoc" typedoc
cp "$tmpdir/index.html" index.html
# rewritten every deploy, because an orphan branch starts without it and Pages drops the domain
cp "$tmpdir/CNAME" CNAME

# scoped rather than 'git add -A': the working tree still holds source, build output and
# node_modules, and gh-pages carries no .gitignore to keep them out
git add -A -- typedoc index.html CNAME

if git diff --cached --quiet; then
	echo "No TypeDoc changes to deploy."
	exit 0
fi

git "${commit_as[@]}" commit -m "Update TypeDoc ($1)"
# the branch was built on origin/gh-pages, so this fast-forwards and never needs -f
git push origin gh-pages
