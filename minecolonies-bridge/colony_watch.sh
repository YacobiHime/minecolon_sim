#!/bin/bash
# colony_watch.sh - unattended colony monitor. Emits one line per actionable
# event; self-heals the node agents (they are safe to restart), only reports
# server/bridge problems (those need investigation, not blind restarts).
BRIDGE=http://localhost:8089
DIR=/home/mine-admin/minecolon_sim/minecolonies-bridge
POLL=120
HEARTBEAT_EVERY=30   # polls -> 30*120s = 60 min
IDLE_THRESHOLD=3     # emit an event only when >= this many staffed-but-idle workplaces
# Idle detection runs only during daytime work-hours. At night every citizen is
# SLEEPING (jobStatus reports "idle" - the JobStatus enum has no sleep state), so
# a night sample counts the whole colony as idle: a false positive. gameTime
# (already in /status) mod 24000 is the Minecraft time-of-day; workers wake near
# dawn (0) and go to bed at dusk (~12000). We sample only inside a window that is
# solidly daytime, avoiding the dawn wake / dusk commute transitions too. Genuine
# problems (unseeded farm, material-starved crafter) are idle ALL day, so they
# still land in this window; only night sleep is excluded.
DAY_START=2000
DAY_END=11000
bridge_down=0
n=0

while true; do
  n=$((n+1))

  # --- bridge / server alive ---
  if curl -s --max-time 5 $BRIDGE/ping 2>/dev/null | grep -q ok; then
    if [ "$bridge_down" = 1 ]; then echo "RECOVERED: bridge is answering again"; fi
    bridge_down=0
  else
    if [ "$bridge_down" = 0 ]; then echo "PROBLEM: bridge/server not answering (crash? boot?)"; fi
    bridge_down=1
    sleep $POLL; continue
  fi

  # --- agents: exactly one of each; restart if dead ---
  # Anchor with $ so the lingering `bash -c ...` setsid wrapper (whose cmdline
  # merely CONTAINS the string) doesn't count as a second instance.
  sb=$(pgrep -fc 'node supply_bot\.js$')
  if [ "$sb" = "0" ]; then
    (cd $DIR && setsid nohup node supply_bot.js >> supply_bot.log 2>&1 &)
    echo "ACTION: supply_bot was dead - restarted"
  elif [ "$sb" -gt 1 ]; then
    echo "PROBLEM: $sb supply_bot processes running (must be 1)"
  fi
  cl=$(pgrep -fc 'node council\.js$')
  if [ "$cl" = "0" ]; then
    (cd $DIR && setsid nohup node council.js >> council5.log 2>&1 &)
    echo "ACTION: council was dead (MAX_CYCLES reached?) - restarted"
  fi

  # --- colony health thresholds ---
  read -r sick starving citizens daytime <<< "$(curl -s --max-time 10 $BRIDGE/status 2>/dev/null | python3 -c "
import json,sys
try:
    c=json.load(sys.stdin)[0]
    cit=c['citizens']
    print(sum(1 for x in cit if x.get('sick')),
          sum(1 for x in cit if x.get('saturation',99)<=2.5), len(cit),
          int(c.get('gameTime',0)) % 24000)
except Exception:
    print('- - - -')
" 2>/dev/null)"
  if [ "$sick" != "-" ] && [ -n "$sick" ]; then
    if [ "$sick" -gt 5 ] 2>/dev/null; then
      echo "PROBLEM: $sick citizens sick (sickness spiral watch: threshold 5)"
    fi
    if [ "$starving" -gt 10 ] 2>/dev/null; then
      echo "PROBLEM: $starving citizens starving (sat<=2.5)"
    fi
  fi

  # --- keepalive failure (colony brain freeze) ---
  if tail -200 /home/mine-admin/mc-server-forge/console.log 2>/dev/null | grep -q 'keepColoniesActive failed'; then
    echo "PROBLEM: keepColoniesActive failing (unattended colony will freeze)"
  fi

  # --- idle-workplace check (staffed citizens who aren't actually working) ---
  # work_stats.js samples /status a few times (~6s of blocking), so this runs
  # only on the heartbeat cadence, not every poll. Skipped at night (idle_n=night)
  # so colony-wide sleep isn't mistaken for idleness. Emits an event only when the
  # idle count crosses IDLE_THRESHOLD (quiet under Monitor). idle_n is also fed
  # into the heartbeat line below. timeout + || true so a slow/failed sample
  # never kills the watcher.
  idle_n="-"
  if [ $((n % HEARTBEAT_EVERY)) -eq 1 ]; then
    # Daytime gate: run only when time-of-day is inside the work-hours window.
    # If daytime is unknown ("-", parse failed) fail open and still check.
    is_day=1
    if [ "$daytime" != "-" ] && [ -n "$daytime" ] 2>/dev/null; then
      if [ "$daytime" -lt "$DAY_START" ] 2>/dev/null || [ "$daytime" -gt "$DAY_END" ] 2>/dev/null; then
        is_day=0
      fi
    fi
    if [ "$is_day" = 0 ]; then
      idle_n="night"
    else
      idle_line=$(cd $DIR && WORK_STATS_BRIEF=1 timeout 45 node work_stats.js 3 3000 2>/dev/null | grep '^BRIEF ' || true)
      if [ -n "$idle_line" ]; then
        idle_n=$(echo "$idle_line" | sed -n 's/^BRIEF total=[0-9]* idle=\([0-9]*\).*/\1/p')
        [ -z "$idle_n" ] && idle_n="-"
        if [ "$idle_n" != "-" ] && [ "$idle_n" -ge "$IDLE_THRESHOLD" ] 2>/dev/null; then
          detail=$(echo "$idle_line" | cut -d' ' -f4- | tr ' ' '\n' | head -6 | tr '\n' ' ')
          echo "IDLE WORKPLACES: $idle_n staffed but not working (${detail%% })"
        fi
      fi
    fi
  fi

  # --- hourly heartbeat with audit summary ---
  if [ $((n % HEARTBEAT_EVERY)) -eq 1 ]; then
    audit=$(cd $DIR && node verify_suite.js 2>/dev/null | sed -n 2p)
    echo "HEARTBEAT: citizens=$citizens sick=$sick starving=$starving | $audit | daytime=$daytime idle-workplaces=$idle_n"
  fi

  sleep $POLL
done
