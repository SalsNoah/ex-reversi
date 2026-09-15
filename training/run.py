"""CLI entry helpers that add training/ to sys.path."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _dispatch(mod: str) -> None:
    m = __import__(f"ex_osero_rl.{mod}", fromlist=["main"])
    raise SystemExit(m.main())


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    mapping = {
        "check": "check",
        "train": "train",
        "evaluate": "evaluate",
        "diagnose": "diagnose",
        "speed": "speed_bench",
        "evaluate-phase6": "evaluate_phase6",
    }
    if cmd not in mapping:
        print(f"unknown command: {cmd}", file=sys.stderr)
        print("known:", ", ".join(mapping), file=sys.stderr)
        raise SystemExit(2)
    _dispatch(mapping[cmd])
