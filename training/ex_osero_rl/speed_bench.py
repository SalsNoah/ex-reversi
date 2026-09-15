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


def run_speed(model_path: Path, compress: bool, episodes: int, seed0: int) -> dict:
    model = MaskablePPO.load(str(model_path), device="cpu")
    env = ExtremeOthelloEnv(
        compress_forced_wait=compress,
        use_matchup_schedule=True,
        schedule_seed=seed0,
    )
    wall0 = time.perf_counter()
    t_infer = 0.0
    t_step = 0.0
    env_steps = 0
    infer_count = 0
    game_ms = 0
    finished = 0
    for _ in range(episodes):
        obs, info = env.reset(seed=seed0 + finished)
        done = False
        start_elapsed = int(info.get("elapsedMs") or 0)
        while not done:
            t0 = time.perf_counter()
            mask = env.action_masks()
            action, _ = model.predict(obs, action_masks=mask, deterministic=True)
            t_infer += time.perf_counter() - t0
            infer_count += 1
            t1 = time.perf_counter()
            obs, reward, term, trunc, info = env.step(int(action))
            t_step += time.perf_counter() - t1
            env_steps += 1
            done = term or trunc
        finished += 1
        game_ms += int(info.get("elapsedMs") or 0) - start_elapsed
    wall = time.perf_counter() - wall0
    stats = dict(env.stats)
    env.close()
    return {
        "compress_forced_wait": compress,
        "episodes": finished,
        "wall_seconds": wall,
        "env_steps": env_steps,
        "infer_count": infer_count,
        "bridge_roundtrips_approx": env_steps + finished,  # reset+step
        "internal_50ms_steps": stats.get("internal_50ms_steps", env_steps),
        "forced_wait_auto_steps": stats.get("forced_wait_auto_steps", 0),
        "game_ms_advanced": game_ms,
        "episodes_per_wall_s": finished / wall if wall else None,
        "game_ms_per_wall_s": game_ms / wall if wall else None,
        "env_steps_per_wall_s": env_steps / wall if wall else None,
        "internal_50ms_per_wall_s": (
            float(stats.get("internal_50ms_steps", env_steps)) / wall if wall else None
        ),
        "time_infer_s": t_infer,
        "time_env_step_incl_bridge_s": t_step,
        "time_other_s": wall - t_infer - t_step,
        "note": (
            "time_env_step は通信+TS処理を含む。"
            "infer と step は重複しないよう分けた。"
            "単位の異なる steps/s を同一視しない。"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        default=str(
            TRAINING_ROOT
            / "artifacts"
            / "phase5-smoke-001"
            / "initial_model.zip"
        ),
    )
    parser.add_argument("--episodes", type=int, default=4)
    parser.add_argument("--out-run-id", default="phase6-speed-001")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    out = TRAINING_ROOT / "artifacts" / args.out_run_id
    if out.exists() and any(out.iterdir()) and not args.force:
        raise SystemExit(f"refuse overwrite {out}")
    out.mkdir(parents=True, exist_ok=True)

    fine = run_speed(Path(args.model), compress=False, episodes=args.episodes, seed0=9000)
    comp = run_speed(Path(args.model), compress=True, episodes=args.episodes, seed0=9000)
    report = {
        "model": args.model,
        "episodes_each": args.episodes,
        "fine_50ms": fine,
        "compress": comp,
        "ratio_game_ms_per_wall": (
            (comp["game_ms_per_wall_s"] / fine["game_ms_per_wall_s"])
            if fine["game_ms_per_wall_s"] and comp["game_ms_per_wall_s"]
            else None
        ),
        "ratio_episodes_per_wall": (
            (comp["episodes_per_wall_s"] / fine["episodes_per_wall_s"])
            if fine["episodes_per_wall_s"] and comp["episodes_per_wall_s"]
            else None
        ),
    }
    (out / "speed.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    lines = [
        f"# 速度比較 `{args.out_run_id}`",
        "",
        f"モデル: {args.model}",
        f"各方式 {args.episodes} 試合",
        "",
        "## 従来（50msごと）",
        f"- 壁時計: {fine['wall_seconds']:.2f}s",
        f"- 試合/s: {fine['episodes_per_wall_s']}",
        f"- ゲーム内ms/s: {fine['game_ms_per_wall_s']}",
        f"- 環境steps/s: {fine['env_steps_per_wall_s']}",
        f"- 推論回数: {fine['infer_count']}",
        f"- 推論時間: {fine['time_infer_s']:.2f}s / step+通信: {fine['time_env_step_incl_bridge_s']:.2f}s",
        "",
        "## 強制WAIT圧縮",
        f"- 壁時計: {comp['wall_seconds']:.2f}s",
        f"- 試合/s: {comp['episodes_per_wall_s']}",
        f"- ゲーム内ms/s: {comp['game_ms_per_wall_s']}",
        f"- 環境steps/s: {comp['env_steps_per_wall_s']}（判断回数ベース。50ms steps/sと同列比較しない）",
        f"- 内部50ms/s: {comp['internal_50ms_per_wall_s']}",
        f"- 推論回数: {comp['infer_count']}",
        f"- 自動強制WAIT: {comp['forced_wait_auto_steps']}",
        "",
        f"- ゲーム内時間スループット比（compress/fine）: {report['ratio_game_ms_per_wall']}",
        f"- 試合スループット比: {report['ratio_episodes_per_wall']}",
    ]
    (out / "speed.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"saved": str(out / "speed.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
