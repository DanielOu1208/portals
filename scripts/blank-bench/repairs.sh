#!/bin/zsh
# Each repair of a blank chat (BlankProbe.Repair, PORTALS_DEBUG_BLANK_FIX) on the same
# openings, after a run with none: scripts/blank-bench.sh once per mode, the runs under
# OUT/<mode>, their summaries one after another in OUT/repairs.txt.
#
#   scripts/blank-bench/repairs.sh --sim <udid> --app <built .app> --xctestrun <file> \
#       [--modes "none last last-end previous nudge nudge-now layout"] [--steps "…"] [--plain] [blank-bench options]
#
# Without a mode the app opens threads as it does now (settle one move a frame, a blank
# chat moved to its last turn). A mode can also be `before` (PORTALS_DEBUG_BLANK_SETTLE=
# before: as before that fix of 2026-10-19), or several joined by + (`before+last`).
# --plain: the bench's own plan (streaming, coming back, ended in the background) and
# relaunches, instead of the openings of Visuals 45.

set -uo pipefail
ROOT=${0:A:h:h:h}
OUT=${OUT:-/tmp/portals-blank-repro/out/repairs-$(date +%H%M%S)}
MODES="none last last-end previous nudge nudge-now layout"
STEPS=""
PASS=()
while (( $# )); do
  case $1 in
    --modes) MODES=$2; shift 2;;
    --steps) STEPS=$2; shift 2;;
    --plain) PLAIN=1; shift;;
    *) PASS+=($1); shift;;
  esac
done
PLAIN=${PLAIN:-0}
# Visuals 45 opened blank at almost every opening from memory on 2026-10-19: five
# openings of it between a long thread's, a short drag after the last.
[[ -n $STEPS ]] || STEPS="tap:Visuals_45 tap:Long_60 tap:Visuals_45 tap:Long_45 tap:Visuals_45 tap:Long_60 tap:Visuals_45 tap:Streaming_45 tap:Visuals_45 drag"
mkdir -p $OUT
failures=0
for mode in ${=MODES}; do
  # A mode is a repair, `none`, `before` (PORTALS_DEBUG_BLANK_SETTLE=before), or
  # several joined by +.
  extra=()
  for part in ${(s:+:)mode}; do
    case $part in
      none) ;;
      before) extra+=(--env PORTALS_DEBUG_BLANK_SETTLE=before);;
      *) extra+=(--env PORTALS_DEBUG_BLANK_FIX=$part);;
    esac
  done
  if (( PLAIN )); then
    OUT=$OUT/$mode $ROOT/scripts/blank-bench.sh "${PASS[@]}" $extra > $OUT/$mode.log 2>&1 || failures=$(( failures + 1 ))
  else
    OUT=$OUT/$mode $ROOT/scripts/blank-bench.sh "${PASS[@]}" --relaunches 0 --steps "$STEPS" $extra > $OUT/$mode.log 2>&1 || failures=$(( failures + 1 ))
  fi
  { print -r -- "== $mode"; cat $OUT/$mode/summary.txt 2>/dev/null; } | tee -a $OUT/repairs.txt
done
(( failures == 0 ))
