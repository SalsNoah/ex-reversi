from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from sb3_contrib import MaskablePPO

from ex_osero_rl.env import ExtremeOthelloEnv, WAIT_ACTION

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PROJECT_ROOT / "training"

EVAL_SEEDS = list(range(5000, 5010))  # 10 seeds, distinct from training schedule


def play_episode(
    model: MaskablePPO,
    opponent: str,
    learner_side: str,
    match_seed: int,
) -> dict:
    env = ExtremeOthelloEnv(
        cooldown_ms=700,
        think_delay_ms=500,
        use_matchup_schedule=False,
    )
    obs, info = env.reset(
        seed=match_seed,
        options={
            "opponent": opponent,
            "learner_side": learner_side,
            "seed": match_seed,
        },
    )
    total_reward = 0.0
    voluntary_waits = 0
    move_success = 0
    steps = 0
    abnormal = False
    try:
        while True:
            mask = env.action_masks()
            action, _ = model.predict(
                obs, action_masks=mask, deterministic=True
            )
            action = int(action)
            can_place = bool(np.any(mask[:-1]))
            if can_place and action == WAIT_ACTION:
                voluntary_waits += 1
            obs, reward, terminated, truncated, info = env.step(action)
            total_reward += float(reward)
            steps += 1
            if info.get("moveSuccess") or info.get("applied"):
                move_success += 1
            if truncated and not terminated:
                abnormal = True
                break
            if terminated:
                break
    except Exception as exc:
        abnormal = True
        info = {"error": str(exc)}
    finally:
        env.close()

    outcome = info.get("outcome")
    counts = info.get("stoneCounts") or {}
    if learner_side == "black":
        stone_diff = int(counts.get("black", 0)) - int(counts.get("white", 0))
        win = outcome == "black_win"
        loss = outcome == "white_win"
    else:
        stone_diff = int(counts.get("white", 0)) - int(counts.get("black", 0))
        win = outcome == "white_win"
        loss = outcome == "black_win"
    draw = outcome == "draw"

    return {
        "opponent": opponent,
        "learner_side": learner_side,
        "match_seed": match_seed,
        "steps": steps,
        "reward": total_reward,
        "win": bool(win),
        "loss": bool(loss),
        "draw": bool(draw),
        "stone_diff": stone_diff,
        "move_success": move_success,
        "voluntary_waits": voluntary_waits,
        "abnormal": abnormal,
        "end_reason": info.get("endReason"),
        "outcome": outcome,
    }


def aggregate(cases: list[dict]) -> dict:
    n = len(cases)
    wins = sum(1 for c in cases if c["win"])
    losses = sum(1 for c in cases if c["loss"])
    draws = sum(1 for c in cases if c["draw"])
    abnormal = sum(1 for c in cases if c["abnormal"])
    return {
        "matches": n,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "win_rate": wins / n if n else 0.0,
        "score_rate": (wins + 0.5 * draws) / n if n else 0.0,
        "avg_stone_diff": float(np.mean([c["stone_diff"] for c in cases])) if n else 0.0,
        "move_success_total": sum(c["move_success"] for c in cases),
        "voluntary_waits_total": sum(c["voluntary_waits"] for c in cases),
        "abnormal": abnormal,
    }


def evaluate_model(model_path: Path) -> dict:
    model = MaskablePPO.load(str(model_path), device="cpu")
    cases: list[dict] = []
    wall0 = time.perf_counter()
    for opponent in ("random", "max_flip"):
        for seed in EVAL_SEEDS:
            for side in ("black", "white"):
                cases.append(play_episode(model, opponent, side, seed))
    wall = time.perf_counter() - wall0

    by_key: dict[str, list[dict]] = {}
    for c in cases:
        key = f"{c['opponent']}_{c['learner_side']}"
        by_key.setdefault(key, []).append(c)

    return {
        "model": str(model_path),
        "wall_seconds": wall,
        "overall": aggregate(cases),
        "by_condition": {k: aggregate(v) for k, v in by_key.items()},
        "cases": cases,
    }


def verify_reload(model_path: Path, out_dir: Path) -> dict:
    """別プロセス想定の読み直し一致確認（同一プロセス内でも load で検証）。"""
    from ex_osero_rl.bridge import NodeBridge

    model_a = MaskablePPO.load(str(model_path), device="cpu")
    model_b = MaskablePPO.load(str(model_path), device="cpu")

    bridge = NodeBridge()
    bridge.start()
    probes = []
    # 初期 / 中盤寄り / 待機 / 終盤寄り: シード違いで複数状態を取る
    for seed, side, opponent, n_wait in [
        (7001, "black", "random", 0),
        (7002, "white", "max_flip", 40),
        (7003, "black", "random", 200),
        (7004, "white", "max_flip", 800),
    ]:
        data = bridge.request(
            {
                "cmd": "reset",
                "seed": seed,
                "learnerSide": side,
                "opponent": opponent,
                "cooldownMs": 700,
                "thinkDelayMs": 500,
            }
        )
        obs = np.asarray(data["observation"], dtype=np.float32)
        mask = np.asarray(data["actionMask"], dtype=bool)
        for _ in range(n_wait):
            if data.get("terminated"):
                break
            # WAIT で時間だけ進める
            data = bridge.request({"cmd": "step", "action": WAIT_ACTION})
            obs = np.asarray(data["observation"], dtype=np.float32)
            mask = np.asarray(data["actionMask"], dtype=bool)
            if data.get("terminated") or data.get("truncated"):
                break
        if data.get("terminated") or data.get("truncated"):
            # 終局なら別シードで初期を使う
            data = bridge.request(
                {
                    "cmd": "reset",
                    "seed": seed + 100,
                    "learnerSide": side,
                    "opponent": opponent,
                    "cooldownMs": 700,
                    "thinkDelayMs": 500,
                }
            )
            obs = np.asarray(data["observation"], dtype=np.float32)
            mask = np.asarray(data["actionMask"], dtype=bool)

        a, _ = model_a.predict(obs, action_masks=mask, deterministic=True)
        b, _ = model_b.predict(obs, action_masks=mask, deterministic=True)
        probes.append(
            {
                "seed": seed,
                "side": side,
                "opponent": opponent,
                "n_wait": n_wait,
                "action_a": int(a),
                "action_b": int(b),
                "match": int(a) == int(b),
                "elapsedMs": data.get("info", {}).get("elapsedMs"),
            }
        )

    # 読み込み後に1試合完走
    full = play_episode(model_b, "random", "black", 7100)
    bridge.close()

    result = {
        "probes": probes,
        "all_match": all(p["match"] for p in probes),
        "full_match_after_reload": full,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "reload_verify.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--models",
        nargs="+",
        default=["initial_model.zip", "trained_model.zip"],
    )
    args = parser.parse_args()

    art = TRAINING_ROOT / "artifacts" / args.run_id
    if not art.exists():
        raise SystemExit(f"artifact dir not found: {art}")

    reports = {}
    for name in args.models:
        path = art / name
        if not path.exists():
            raise SystemExit(f"model not found: {path}")
        print(f"[evaluate] {path}", flush=True)
        reports[name] = evaluate_model(path)

    reload = verify_reload(art / "trained_model.zip", art)

    out = {
        "run_id": args.run_id,
        "eval_seeds": EVAL_SEEDS,
        "note": (
            "少数試合の試験評価。わずかな勝率差だけで強くなったと断定しない。"
            "学習中とは別シード群。"
        ),
        "models": reports,
        "reload_verify": reload,
    }
    (art / "eval_result.json").write_text(
        json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    lines = [
        f"# 学習前後評価 `{args.run_id}`",
        "",
        out["note"],
        "",
        f"評価シード: {EVAL_SEEDS}",
        "",
    ]
    for name, rep in reports.items():
        o = rep["overall"]
        lines += [
            f"## {name}",
            f"- 試合数: {o['matches']}",
            f"- 勝/負/分: {o['wins']}/{o['losses']}/{o['draws']}",
            f"- 勝率: {o['win_rate']:.3f}",
            f"- 得点率: {o['score_rate']:.3f}",
            f"- 平均石差: {o['avg_stone_diff']:.2f}",
            f"- 着手成功合計: {o['move_success_total']}",
            f"- 自発的WAIT合計: {o['voluntary_waits_total']}",
            f"- 異常終了: {o['abnormal']}",
            "",
        ]
        for cond, agg in rep["by_condition"].items():
            lines.append(
                f"- {cond}: W/L/D={agg['wins']}/{agg['losses']}/{agg['draws']} "
                f"win_rate={agg['win_rate']:.3f} score_rate={agg['score_rate']:.3f}"
            )
        lines.append("")

    lines += [
        "## 再読み込み検証",
        f"- deterministic 行動一致: {reload['all_match']}",
        f"- 読込後の完走異常: {reload['full_match_after_reload'].get('abnormal')}",
        "",
    ]
    (art / "eval_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"run_id": args.run_id, "saved": str(art / "eval_result.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
