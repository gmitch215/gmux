#!/bin/zsh
# deploys one worker per arm of the deployed idle-machine measurements and starts a tail on each;
# needs the account in CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN and a log directory in LOGS
# usage: LOGS=<dir> experiments/decisions/scripts/deploy-arms.sh <arm> ...   (arm names from ARMS below)
# usage: LOGS=<dir> experiments/decisions/scripts/deploy-arms.sh teardown <arm> ...
set -e
: ${LOGS:?set LOGS to a directory for the tail logs}
here=${0:A:h}
typeset -A ARMS
ARMS=(
	d2-first '{"turnEnd":"first","wake":"always"}'
	d2-budget '{"turnEnd":"budget","wake":"always"}'
	d2-remaining '{"turnEnd":"remaining","wake":"always"}'
	d2-over '{"turnEnd":"over","wake":"always"}'
	d2r-first '{"turnEnd":"first","wake":"always","rearmBusy":true}'
	d2r-budget '{"turnEnd":"budget","wake":"always","rearmBusy":true}'
	d2r-remaining '{"turnEnd":"remaining","wake":"always","rearmBusy":true}'
	d2r-over '{"turnEnd":"over","wake":"always","rearmBusy":true}'
	d2r-over-idle '{"turnEnd":"over","wake":"always","rearmBusy":true}'
	d3-a '{"wake":"always"}'
	d3-b '{"wake":"always","persistQuiet":true}'
	d1-floor1 '{"wake":"floor","floorMs":60000,"saveWake":true}'
	d1-best '{"wake":"always","persistQuiet":true,"saveWake":true}'
	d1-best-remaining '{"wake":"always","persistQuiet":true,"saveWake":true,"turnEnd":"remaining"}'
)
if [[ $1 == teardown ]]; then
	shift
	for arm in "$@"; do
		pkill -f "wrangler tail gmux-dec-$arm" || true
		(cd $here/../../.. && bunx wrangler delete --name gmux-dec-$arm --force)
	done
	exit 0
fi
for arm in "$@"; do
	(cd $here/../../.. && bunx wrangler deploy --config experiments/decisions/wrangler.jsonc --name gmux-dec-$arm --define "KEEPER_POLICY:${ARMS[$arm]}")
	(cd $here/../../.. && nohup bunx wrangler tail gmux-dec-$arm --format json > $LOGS/tail-$arm.jsonl 2> $LOGS/tail-$arm.err &)
done
