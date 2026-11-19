#!/bin/bash
# Start, stop or check the Aside Listener (scripts/mac-listener.py) in the background.
#
#   aside-listener.sh toggle   start it if stopped, stop it if running (what the app icon does)
#   aside-listener.sh start | stop | status | log
#
# Extra arguments after "start" or "toggle" go to the listener, e.g.  start --project personal
set -u

REAL_HOME="$(eval echo "~$(id -un)")"          # the real home, even when HOME is redirected
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$REAL_HOME/.aside-relay"
PIDFILE="$STATE/listener.pid"
LOGFILE="$STATE/listener.log"
PYTHON=/usr/bin/python3
mkdir -p "$STATE"

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q "mac-listener.py"
}

say_status() {                                   # spoken and visible confirmation, no windows
  /usr/bin/osascript -e "display notification \"$1\" with title \"Aside Listener\"" >/dev/null 2>&1 || true
  /usr/bin/say -v Samantha -r 200 "$2" >/dev/null 2>&1 || true
}

start() {
  if is_running; then echo "already running (pid $(cat "$PIDFILE"))"; return 0; fi
  if ! curl -s -o /dev/null --max-time 3 http://127.0.0.1:8799/api/health; then
    echo "relay is not running on 127.0.0.1:8799"
    say_status "The relay is not running, so the listener could not start." "The relay is not running."
    return 1
  fi
  nohup "$PYTHON" "$DIR/mac-listener.py" "$@" >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  if is_running; then
    echo "started (pid $(cat "$PIDFILE"))"
    say_status "Listening. Finished chat replies will be read aloud." "Aside listener on."
  else
    echo "failed to start; see $LOGFILE"
    say_status "The listener did not start. See ~/.aside-relay/listener.log" "Listener failed to start."
    return 1
  fi
}

stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" 2>/dev/null
    rm -f "$PIDFILE"
    echo "stopped"
    say_status "Stopped." "Aside listener off."
  else
    rm -f "$PIDFILE"
    echo "not running"
  fi
}

case "${1:-toggle}" in
  start)  shift; start "$@" ;;
  stop)   stop ;;
  status) if is_running; then echo "running (pid $(cat "$PIDFILE"))"; else echo "stopped"; fi ;;
  log)    tail -n 40 "$LOGFILE" ;;
  toggle) shift 2>/dev/null; if is_running; then stop; else start "$@"; fi ;;
  *)      echo "usage: aside-listener.sh [toggle|start|stop|status|log]"; exit 2 ;;
esac
