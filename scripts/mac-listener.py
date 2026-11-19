#!/usr/bin/env python3
"""Reads finished Aside replies aloud on this Mac with the built-in `say` command.

A little test listener for aside-relay. It polls the local relay, notices chats that just
finished, and speaks the reply's <speak>...</speak> summary (or its first two sentences when
there is no tag). Standard library only; no windows are opened.

  python3 scripts/mac-listener.py                  # speak every chat that finishes
  python3 scripts/mac-listener.py --dry-run        # print what it would say, stay silent
  python3 scripts/mac-listener.py --project personal --quiet 00:00-12:00

Stop it with Ctrl-C. It never speaks anything that finished before it started.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pwd
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# The real home directory, even when HOME is redirected (as in sandboxed shells).
TOKEN_FILE = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".aside-relay" / "token"
SPEAK = re.compile(r"<speak>([\s\S]*?)</speak>", re.I)
OPEN_SPEAK = re.compile(r"(?:^|\n)[ \t]*<speak>[\s\S]*$", re.I)
NOTE = re.compile(r"\n*\[Voice mode is on\.[^\]]*\]\s*$")


def extract_spoken(text: str, max_chars: int = 320) -> str:
    """The <speak> summary if present, otherwise the first two sentences of the plain reply."""
    # Tags inside code spans or fences are talk about the tag, not the tag itself.
    code: list[str] = []

    def mask(match: re.Match) -> str:
        code.append(match.group(0))
        return f"\ue000{len(code) - 1}\ue001"

    def restore(value: str) -> str:
        return re.sub("\ue000(\\d+)\ue001", lambda m: code[int(m.group(1))], value)

    text = re.sub(r"```[\s\S]*?(?:```|$)|`[^`\n]*`", mask, text)
    tagged = [restore(part).strip() for part in SPEAK.findall(text) if part.strip()]
    if tagged:
        return " ".join(tagged)
    plain = restore(OPEN_SPEAK.sub("", text))
    plain = re.sub(r"```[\s\S]*?```", " ", plain)            # code blocks
    plain = re.sub(r"`([^`]*)`", r"\1", plain)                # inline code
    plain = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", plain)  # links and images
    plain = re.sub(r"<[^>]+>", " ", plain)                    # leftover tags
    plain = re.sub(r"https?://\S+", " ", plain)
    plain = re.sub(r"^[#>\-*+\d.\s|]+", "", plain, flags=re.M)  # headings, bullets, tables
    plain = re.sub(r"[*_~]+", "", plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    sentences = re.split(r"(?<=[.!?])\s+", plain)
    short = " ".join(sentences[:2]).strip()
    if len(short) > max_chars:
        short = short[:max_chars].rsplit(" ", 1)[0] + "..."
    return short


def in_quiet_hours(spec: str | None, now: dt.datetime | None = None) -> bool:
    if not spec:
        return False
    start_text, end_text = spec.split("-", 1)
    start = dt.time.fromisoformat(start_text)
    end = dt.time.fromisoformat(end_text)
    current = (now or dt.datetime.now()).time()
    return start <= current < end if start <= end else current >= start or current < end


class Relay:
    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def get(self, path: str) -> dict:
        request = urllib.request.Request(self.base + path, headers={"Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    def sessions(self) -> list[dict]:
        return self.get("/api/sessions?limit=60").get("items", [])

    def last_reply(self, session_id: str) -> tuple[int, str, float] | None:
        """(seq, text, time in ms) of the newest assistant message after the last user message."""
        messages = self.get(f"/api/sessions/{session_id}/messages?tail=40").get("messages", [])
        last_user = max((m["seq"] for m in messages if m.get("role") == "user"), default=-1)
        for message in reversed(messages):
            if message.get("role") != "assistant" or message["seq"] < last_user:
                continue
            text = "\n".join(b.get("text", "") for b in message.get("blocks", []) if b.get("type") == "text").strip()
            if text:
                return message["seq"], text, float(message.get("ts") or 0)
        return None


def finished(previous: dict, current: dict) -> bool:
    """True when a chat may have a new reply: it stopped running, or it changed while idle.

    A chat that is open in the relay is marked read at once, and short replies can start and end
    between two polls, so "idle and updated since last time" counts. The caller then checks the
    reply's own timestamp, so renames and other edits never trigger speech.
    """
    if current.get("status") in ("running", "errored", "suspended"):
        return False
    return previous.get("status") == "running" or current.get("mtime", 0) > previous.get("mtime", 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:8799")
    parser.add_argument("--interval", type=float, default=4.0, help="seconds between checks")
    parser.add_argument("--voice", default="Samantha")
    parser.add_argument("--rate", type=int, default=190, help="words per minute")
    parser.add_argument("--project", action="append", help="only these project ids (repeatable)")
    parser.add_argument("--routines", action="store_true", help="also read chats titled 'Routine: ...'")
    parser.add_argument("--no-title", action="store_true", help="do not say which chat it came from")
    parser.add_argument("--quiet", metavar="HH:MM-HH:MM", help="stay silent in this window, e.g. 00:00-12:00")
    parser.add_argument("--verbose", action="store_true", help="say why a reply was or was not spoken")
    parser.add_argument("--dry-run", action="store_true", help="print instead of speaking")
    parser.add_argument("--once", type=int, metavar="N", help="exit after speaking N replies (for tests)")
    args = parser.parse_args()

    relay = Relay(args.base, TOKEN_FILE.read_text().strip())
    seen: dict[str, dict] = {}
    spoken: set[tuple[str, int]] = set()
    started_ms = time.time() * 1000 - 2000  # only replies written after the listener started
    count = 0
    is_first_pass = True
    print(f"Listening to {args.base} (voice {args.voice}{', dry run' if args.dry_run else ''}). Waiting for a chat to finish; Ctrl-C to stop.", flush=True)
    while True:
        try:
            items = relay.sessions()
        except (urllib.error.URLError, OSError, ValueError) as error:
            print(f"relay not reachable ({error}); retrying", file=sys.stderr, flush=True)
            time.sleep(max(args.interval, 10))
            continue
        for item in items:
            previous = seen.get(item["id"])
            seen[item["id"]] = item
            if previous is None and not is_first_pass:
                previous = {"status": "idle", "mtime": 0}  # a brand-new chat that already finished
            if previous is None or not finished(previous, item):
                continue  # the first pass is only a baseline
            title = re.sub(r"\s*\[Voi.*$", "", item.get("title") or "").strip().rstrip(".") or "a chat"
            if args.project and item.get("projectId") not in args.project:
                continue
            if title.startswith("Routine:") and not args.routines:
                continue
            reply = relay.last_reply(item["id"])
            if not reply or (item["id"], reply[0]) in spoken or reply[2] < started_ms:
                if args.verbose:
                    print(f"  skip {item['id']} ({title}): no new reply", flush=True)
                continue
            spoken.add((item["id"], reply[0]))
            text = extract_spoken(NOTE.sub("", reply[1]))
            if not text or in_quiet_hours(args.quiet):
                continue
            line = text if args.no_title else f"From {title}. {text}"
            print(f"[{dt.datetime.now():%H:%M:%S}] {item['id']} {line}", flush=True)
            if not args.dry_run:
                subprocess.run(["say", "-v", args.voice, "-r", str(args.rate), "--", line], check=False)
            count += 1
            if args.once and count >= args.once:
                return 0
        is_first_pass = False
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
