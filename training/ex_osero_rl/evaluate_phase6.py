from __future__ import annotations

import argparse
import json
from pathlib import Path

from ex_osero_rl.diagnose import DIAG_NOTE, DIAG_SEEDS, aggregate, evaluate_model

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PROJECT_ROOT / "training"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True, help="今回の学習 run-id")
    parser.add_argument("--phase5-run-id", default="phase5-smoke-001")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    phase6 = TRAINING_ROOT / "artifacts" / args.run_id
    phase5 = TRAINING_ROOT / "artifacts" / args.phase5_run_id
    out = phase6 / "phase6_eval"
    if out.exists() and any(out.iterdir()) and not args.force:
        raise SystemExit(f"refuse overwrite {out}")
    out.mkdir(parents=True, exist_ok=True)

    models = {
        "phase5_initial": phase5 / "initial_model.zip",
        "phase5_trained": phase5 / "trained_model.zip",
        "phase6_trained": phase6 / "trained_model.zip",
    }
    report = {
        "run_id": args.run_id,
        "phase5_run_id": args.phase5_run_id,
        "diag_seeds": DIAG_SEEDS,
        "diag_note": DIAG_NOTE,
        "models": {},
    }
    for name, path in models.items():
        if not path.exists():
            raise SystemExit(f"missing {path}")
        print(f"[eval] {name}", flush=True)
        report["models"][f"{name}_det"] = evaluate_model(path, True)
        report["models"][f"{name}_sto"] = evaluate_model(path, False)

    (out / "eval_result.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    lines = [
        f"# Phase6 評価比較 `{args.run_id}`",
        "",
        DIAG_NOTE,
        "",
        "傾向確認のみ。一般に強くなったとは断定しない。",
        "",
    ]
    for key, ev in report["models"].items():
        o = ev["overall"]
        lines.append(
            f"- {key}: W/L/D={o['wins']}/{o['losses']}/{o['draws']} "
            f"win={o['win_rate']:.3f} score={o['score_rate']:.3f} "
            f"vol_rate={o['mean_voluntary_wait_rate']:.3f} abnormal={o['abnormal']}"
        )
        for cond, agg in ev["by_condition"].items():
            lines.append(
                f"  - {cond}: {agg['wins']}/{agg['losses']}/{agg['draws']} "
                f"score={agg['score_rate']:.3f}"
            )
    (out / "eval_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"saved": str(out / "eval_result.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
