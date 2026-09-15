from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback, CheckpointCallback
from stable_baselines3.common.monitor import Monitor

from ex_osero_rl.env import ExtremeOthelloEnv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PROJECT_ROOT / "training"


class StatsCallback(BaseCallback):
    def __init__(self, env: ExtremeOthelloEnv, verbose: int = 0):
        super().__init__(verbose)
        self.env_ref = env

    def _on_step(self) -> bool:
        return True


class MaskableMonitor(Monitor):
    def action_masks(self):
        return self.env.action_masks()


def net_arch() -> dict:
    return dict(pi=[128, 128], vf=[128, 128])


def save_meta(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def git_commit() -> str | None:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=PROJECT_ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return out.strip()
    except Exception:
        return None


def param_fingerprint(model: MaskablePPO) -> dict:
    total = float(
        sum(p.data.detach().float().norm().item() for p in model.policy.parameters())
    )
    action_sq = 0.0
    value_sq = 0.0
    shared_sq = 0.0
    for name, param in model.policy.named_parameters():
        n = float(param.data.detach().float().norm().item())
        if "action_net" in name:
            action_sq += n * n
        elif "value" in name.lower():
            value_sq += n * n
        else:
            shared_sq += n * n
    has_nan = any(bool(torch.isnan(p).any().item()) for p in model.policy.parameters())
    has_inf = any(bool(torch.isinf(p).any().item()) for p in model.policy.parameters())
    return {
        "total_l2": total,
        "action_net_l2": float(action_sq**0.5),
        "value_net_l2": float(value_sq**0.5),
        "shared_or_other_l2": float(shared_sq**0.5),
        "has_nan": has_nan,
        "has_inf": has_inf,
        "param_count": int(sum(p.numel() for p in model.policy.parameters())),
    }


def policy_state_diff_l2(a: MaskablePPO, b: MaskablePPO) -> float:
    total = 0.0
    for (na, pa), (nb, pb) in zip(
        a.policy.named_parameters(), b.policy.named_parameters(), strict=True
    ):
        assert na == nb
        d = (pa.data - pb.data).float().norm().item()
        total += d * d
    return float(total**0.5)


def build_env(schedule_seed: int, compress: bool) -> ExtremeOthelloEnv:
    return ExtremeOthelloEnv(
        cooldown_ms=700,
        think_delay_ms=500,
        use_matchup_schedule=True,
        schedule_seed=schedule_seed,
        compress_forced_wait=compress,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--timesteps", type=int, default=32768)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cpu")
    parser.add_argument(
        "--compress-forced-wait",
        action="store_true",
        help="学習向け: WAITのみ区間をNode内でまとめる",
    )
    parser.add_argument(
        "--init-from",
        default=None,
        help="既存 zip の policy 重みのみ載せる（optimizer/カウンターは新規）",
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=0,
        help="N 環境ステップごとに checkpoint（0で無効）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="既存 run-id ディレクトリがあっても上書きを許可",
    )
    args = parser.parse_args()

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    art_dir = TRAINING_ROOT / "artifacts" / run_id
    if art_dir.exists() and any(art_dir.iterdir()) and not args.force:
        print(
            f"ERROR: artifacts already exist: {art_dir}\n"
            "別の --run-id を使うか、明示的に --force を付けてください。"
            " phase5-smoke-001 は上書きしないでください。",
            file=sys.stderr,
        )
        return 2
    art_dir.mkdir(parents=True, exist_ok=True)
    log_dir = art_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    versions = {
        "python": sys.version,
        "torch": torch.__version__,
        "numpy": np.__version__,
    }
    try:
        import gymnasium as gym

        versions["gymnasium"] = gym.__version__
    except Exception:
        pass
    try:
        import stable_baselines3 as sb3

        versions["stable_baselines3"] = sb3.__version__
    except Exception:
        pass
    try:
        import sb3_contrib

        versions["sb3_contrib"] = sb3_contrib.__version__
    except Exception:
        pass

    raw_env = build_env(schedule_seed=args.seed, compress=args.compress_forced_wait)
    env = MaskableMonitor(raw_env, filename=str(log_dir / "monitor.csv"))

    policy_kwargs = dict(net_arch=net_arch())
    model = MaskablePPO(
        "MlpPolicy",
        env,
        learning_rate=3e-4,
        n_steps=4096,
        batch_size=256,
        n_epochs=4,
        gamma=1.0,
        gae_lambda=1.0,
        ent_coef=0.01,
        seed=args.seed,
        device=args.device,
        policy_kwargs=policy_kwargs,
        verbose=1,
        tensorboard_log=None,
    )

    init_weight_diff = None
    init_source = None
    if args.init_from:
        init_source = str(Path(args.init_from).resolve())
        donor = MaskablePPO.load(args.init_from, device=args.device)
        model.policy.load_state_dict(donor.policy.state_dict())
        init_weight_diff = policy_state_diff_l2(model, donor)
        # 学習カウンターは 0 のまま、optimizer は MaskablePPO 新規のまま
        print(
            f"[train] loaded policy weights from {init_source} "
            f"diff_l2={init_weight_diff} (expect ~0)",
            flush=True,
        )

    initial_fp = param_fingerprint(model)
    initial_path = art_dir / "initial_model.zip"
    model.save(str(initial_path))

    meta = {
        "run_id": run_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "spec_version": "1.0.0",
        "learner_step_spec_version": (
            "1.1.0-compress-forced-wait"
            if args.compress_forced_wait
            else "1.0.0-per-50ms"
        ),
        "settings": {
            "cooldown_ms": 700,
            "think_delay_ms": 500,
            "step_ms": 50,
            "match_duration_ms": 180_000,
            "obs_dim": 104,
            "action_n": 101,
            "obs_layout": "board[100], myCdN, oppCdN, remainN, thinkN",
            "compress_forced_wait": args.compress_forced_wait,
            "learner_step_meaning": (
                "1 env step = 学習側の判断可能な行動1回 + 必要なら強制WAIT区間の連続50ms"
                if args.compress_forced_wait
                else "1 env step = ゲーム内50ms"
            ),
            "gamma_note": (
                "gamma=1.0のため区間報酬の合計でよい。"
                "将来 gamma<1 にする場合は経過時間に応じた割引設計が必要。"
            ),
        },
        "train": {
            "algorithm": "MaskablePPO",
            "policy": "MlpPolicy",
            "device": args.device,
            "n_envs": 1,
            "total_timesteps": args.timesteps,
            "n_steps": 4096,
            "batch_size": 256,
            "n_epochs": 4,
            "learning_rate": 0.0003,
            "gamma": 1.0,
            "gae_lambda": 1.0,
            "ent_coef": 0.01,
            "net_arch": [128, 128],
            "seed": args.seed,
            "init_from": init_source,
            "init_weight_diff_l2": init_weight_diff,
            "optimizer_reinitialized": True,
            "note": "動作確認用の試験設定であり最適値ではない。",
        },
        "versions": versions,
        "git_commit": git_commit(),
        "initial_param_fingerprint": initial_fp,
    }
    save_meta(art_dir / "run_meta.json", meta)

    callbacks: list = [StatsCallback(raw_env)]
    if args.checkpoint_every and args.checkpoint_every > 0:
        ckpt_dir = art_dir / "checkpoints"
        ckpt_dir.mkdir(exist_ok=True)
        callbacks.append(
            CheckpointCallback(
                save_freq=args.checkpoint_every,
                save_path=str(ckpt_dir),
                name_prefix="ckpt",
                save_replay_buffer=False,
                save_vecnormalize=False,
            )
        )

    print(
        f"[train] start timesteps={args.timesteps} run_id={run_id} "
        f"compress={args.compress_forced_wait}",
        flush=True,
    )
    wall0 = time.perf_counter()
    model.learn(
        total_timesteps=args.timesteps,
        callback=callbacks,
        progress_bar=False,
    )
    wall_s = time.perf_counter() - wall0

    trained_fp = param_fingerprint(model)
    trained_path = art_dir / "trained_model.zip"
    model.save(str(trained_path))

    stats = dict(raw_env.stats)
    result = {
        **meta,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "actual_env_timesteps": int(model.num_timesteps),
        "actual_timesteps": int(model.num_timesteps),
        "wall_seconds": wall_s,
        "env_steps_per_wall_second": (
            float(model.num_timesteps) / wall_s if wall_s > 0 else None
        ),
        "internal_50ms_per_wall_second": (
            float(stats.get("internal_50ms_steps", 0)) / wall_s if wall_s > 0 else None
        ),
        "env_stats": stats,
        "trained_param_fingerprint": trained_fp,
        "params_changed": trained_fp["total_l2"] != initial_fp["total_l2"],
        "artifacts": {
            "initial_model": str(initial_path),
            "trained_model": str(trained_path),
        },
    }
    save_meta(art_dir / "train_result.json", result)

    summary_lines = [
        f"# 試験学習結果 `{run_id}`",
        "",
        f"- 環境ステップ数: {result['actual_env_timesteps']}",
        f"- 内部50msステップ数: {stats.get('internal_50ms_steps')}",
        f"- 強制WAIT自動処理: {stats.get('forced_wait_auto_steps')}",
        f"- 完了試合数: {stats['episodes']}",
        f"- 相手内訳: {stats['by_opponent']}",
        f"- 担当色内訳: {stats['by_side']}",
        f"- 壁時計: {wall_s:.1f} s",
        f"- 環境steps/s: {result['env_steps_per_wall_second']}",
        f"- 内部50ms/s: {result['internal_50ms_per_wall_second']}",
        f"- 着手可能判断: {stats['can_place_steps']}",
        f"- 自発WAIT: {stats['voluntary_waits']}",
        f"- 着手成功: {stats['move_success']}",
        f"- 同時着手競合: {stats['simultaneous_conflicts']}",
        f"- NaN/Inf: {trained_fp['has_nan']}/{trained_fp['has_inf']}",
        f"- action_net L2: {initial_fp['action_net_l2']:.4f} → {trained_fp['action_net_l2']:.4f}",
        f"- value_net L2: {initial_fp['value_net_l2']:.4f} → {trained_fp['value_net_l2']:.4f}",
        f"- compress_forced_wait: {args.compress_forced_wait}",
        "",
        "注: 環境ステップと内部50msステップは単位が異なる。",
        "注: 本設定は最適値ではない。",
    ]
    (art_dir / "train_summary.md").write_text(
        "\n".join(summary_lines) + "\n", encoding="utf-8"
    )

    env.close()
    print(json.dumps({"run_id": run_id, "wall_seconds": wall_s}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
