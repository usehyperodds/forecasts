#!/bin/sh
# Commits the given paths when they changed and pushes with the job's token, which only the step
# running this script receives. Usage: publish.sh records|board <path>...
set -eu
kind=$1
shift
git add -- "$@"
if git diff --cached --quiet; then
  echo "$kind unchanged"
  exit 0
fi
if [ "$kind" = records ]; then
  days=$(git diff --cached --name-only --diff-filter=A -- 'records/*.jsonl' | sed 's|^records/||; s|\.jsonl$||' | paste -sd ' ' -)
  message="record ${days:-index}"
else
  message="board and settlements"
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "$message"
auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
  git push -q origin "HEAD:$GITHUB_REF_NAME"
echo "pushed: $message"
