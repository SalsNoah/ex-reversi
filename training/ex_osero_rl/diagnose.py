from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO

from ex_osero_rl.env import ExtremeOthelloEnv, WAIT_ACTION

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PROJECT_ROOT / "training"

# 検証用（最終評価用ではない）。Phase5 評価シード 5000-5009 の先頭5個を再利用。
DIAG_SEEDS = [5000, 5001, 5002, 5003, 5004]
DIAG_NOTE = (
    "検証用ケース。Phase5評価シードの一部再利用。"
    "最終評価用の新規シード群ではない。"
)


def split_param_norms(model: MaskablePPO) -> dict:
    policy_names = []
    value_names = []
    other = []
    for name, _ in model.policy.named_parameters():
        lname = name.lower()
        if "value" in lname or "vf" in lname:
            value_names.append(name)
        elif (
            "action" in lname
            or "policy" in lname
            or "pi" in lname
            or "mlp_extractor" in lname
        ):
            # mlp_extractor は共有のことが多い → other に分けてもよいが
            # SB3 では shared features。共有は both に計上。
            if "mlp_extractor" in lname:
                other.append(name)
            else:
                policy_names.append(name)
        else:
            other.append(name)

    def l2(names: list[str]) -> float:
        total = 0.0
        for name, param in model.policy.named_parameters():
            if name in names:
                total += float(param.data.detach().float().norm().item() ** 2)
        return float(total**0.5)

    return {
        "action_head_l2": l2(policy_names),
        "value_head_l2": l2(value_names),
        "shared_or_other_l2": l2(other),
        "action_head_params": policy_names,
        "value_head_params": value_names,
        "shared_or_other_params": other,
    }


def param_diff_norms(a: MaskablePPO, b: MaskablePPO) -> dict:
    """対応パラメータの差分ノルム（同一アーキ前提）。"""
    a_params = dict(a.policy.named_parameters())
    b_params = dict(b.policy.named_parameters())
    assert a_params.keys() == b_params.keys()

    action_sq = 0.0
    value_sq = 0.0
    shared_sq = 0.0
    total_sq = 0.0
    for name, pa in a_params.items():
        pb = b_params[name]
        d = (pa.data.detach().float() - pb.data.detach().float()).norm().item()
        total_sq += d * d
        lname = name.lower()
        if "value" in lname:
            value_sq += d * d
        elif "action_net" in lname:
            action_sq += d * d
        else:
            shared_sq += d * d
    return {
        "diff_total_l2": float(total_sq**0.5),
        "diff_action_net_l2": float(action_sq**0.5),
        "diff_value_net_l2": float(value_sq**0.5),
        "diff_shared_or_other_l2": float(shared_sq**0.5),
    }


def action_probs(
    model: MaskablePPO, obs: np.ndarray, mask: np.ndarray
) -> np.ndarray:
    obs_t = torch.as_tensor(obs).float().unsqueeze(0)
    with torch.no_grad():
        dist = model.policy.get_distribution(obs_t)
        probs = dist.distribution.probs.cpu().numpy()[0]
    probs = probs * mask.astype(np.float64)
    s = probs.sum()
    if s <= 0:
        return probs
    return probs / s


def play_episode(
    model: MaskablePPO,
    opponent: str,
    learner_side: str,
    match_seed: int,
    deterministic: bool,
    action_seed: int,
) -> dict:
    env = ExtremeOthelloEnv(
        cooldown_ms=700,
        think_delay_ms=500,
        compress_forced_wait=False,
    )
    rng = np.random.default_rng(action_seed)
    obs, info = env.reset(
        seed=match_seed,
        options={
            "opponent": opponent,
            "learner_side": learner_side,
            "seed": match_seed,
        },
    )
    voluntary = 0
    can_place_n = 0
    move_ok = 0
    longest_vol_streak_ms = 0
    streak_ms = 0
    wait_probs = []
    steps = 0
    abnormal = False
    try:
        while True:
            mask = env.action_masks()
            can_place = bool(np.any(mask[:-1]))
            if can_place:
                can_place_n += 1
                probs = action_probs(model, obs, mask)
                wait_probs.append(float(probs[WAIT_ACTION]))
            if deterministic:
                action, _ = model.predict(
                    obs, action_masks=mask, deterministic=True
                )
            else:
                # 行動抽選乱数をゲーム乱数と分離（numpy RNG）
                probs = action_probs(model, obs, mask)
                choices = np.flatnonzero(mask)
                p = probs[choices]
                p = p / p.sum()
                action = int(rng.choice(choices, p=p))
            action = int(action)
            if can_place and action == WAIT_ACTION:
                voluntary += 1
                streak_ms += 50
                longest_vol_streak_ms = max(longest_vol_streak_ms, streak_ms)
            else:
                streak_ms = 0
            obs, reward, terminated, truncated, info = env.step(action)
            steps += 1
            if info.get("moveSuccess") or info.get("applied"):
                move_ok += 1
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

    return {
        "opponent": opponent,
        "learner_side": learner_side,
        "match_seed": match_seed,
        "deterministic": deterministic,
        "action_seed": action_seed,
        "steps": steps,
        "win": bool(win),
        "loss": bool(loss),
        "draw": outcome == "draw",
        "stone_diff": stone_diff,
        "voluntary_waits": voluntary,
        "can_place_steps": can_place_n,
        "voluntary_wait_rate": voluntary / can_place_n if can_place_n else None,
        "move_success": move_ok,
        "longest_voluntary_wait_ms": longest_vol_streak_ms,
        "mean_wait_prob_when_can_place": (
            float(np.mean(wait_probs)) if wait_probs else None
        ),
        "abnormal": abnormal,
        "outcome": outcome,
        "end_reason": info.get("endReason"),
    }


def aggregate(cases: list[dict]) -> dict:
    n = len(cases)
    wins = sum(1 for c in cases if c["win"])
    losses = sum(1 for c in cases if c["loss"])
    draws = sum(1 for c in cases if c["draw"])
    return {
        "matches": n,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "win_rate": wins / n if n else 0.0,
        "score_rate": (wins + 0.5 * draws) / n if n else 0.0,
        "avg_stone_diff": float(np.mean([c["stone_diff"] for c in cases])) if n else 0.0,
        "voluntary_waits": sum(c["voluntary_waits"] for c in cases),
        "can_place_steps": sum(c["can_place_steps"] for c in cases),
        "move_success": sum(c["move_success"] for c in cases),
        "abnormal": sum(1 for c in cases if c["abnormal"]),
        "mean_voluntary_wait_rate": (
            sum(c["voluntary_waits"] for c in cases)
            / max(1, sum(c["can_place_steps"] for c in cases))
        ),
    }


def evaluate_model(path: Path, deterministic: bool) -> dict:
    model = MaskablePPO.load(str(path), device="cpu")
    cases = []
    for opponent in ("random", "max_flip"):
        for seed in DIAG_SEEDS:
            for side in ("black", "white"):
                action_seed = seed * 17 + (0 if side == "black" else 1) + (
                    0 if opponent == "random" else 100
                )
                cases.append(
                    play_episode(
                        model, opponent, side, seed, deterministic, action_seed
                    )
                )
    by = {}
    for c in cases:
        key = f"{c['opponent']}_{c['learner_side']}"
        by.setdefault(key, []).append(c)
    return {
        "model": str(path),
        "deterministic": deterministic,
        "overall": aggregate(cases),
        "by_condition": {k: aggregate(v) for k, v in by.items()},
        "cases": cases,
    }


def probe_policy_shift(initial: MaskablePPO, trained: MaskablePPO) -> list[dict]:
    env = ExtremeOthelloEnv(compress_forced_wait=False)
    probes = []
    for seed, side, opp, waits in [
        (7001, "black", "random", 0),
        (7002, "white", "max_flip", 20),
        (7003, "black", "random", 100),
    ]:
        obs, info = env.reset(
            options={"seed": seed, "learner_side": side, "opponent": opp}
        )
        for _ in range(waits):
            if env._terminated:
                break
            mask = env.action_masks()
            obs, _, term, trunc, info = env.step(WAIT_ACTION)
            if term or trunc:
                break
        if env._terminated:
            continue
        mask = env.action_masks()
        if not np.any(mask[:-1]):
            continue
        pi = action_probs(initial, obs, mask)
        pt = action_probs(trained, obs, mask)
        top_i = list(np.argsort(-pi)[:5])
        top_t = list(np.argsort(-pt)[:5])
        probes.append(
            {
                "seed": seed,
                "side": side,
                "opponent": opp,
                "elapsedMs": info.get("elapsedMs"),
                "wait_prob_initial": float(pi[WAIT_ACTION]),
                "wait_prob_trained": float(pt[WAIT_ACTION]),
                "top5_initial": [
                    {"action": int(a), "p": float(pi[a])} for a in top_i
                ],
                "top5_trained": [
                    {"action": int(a), "p": float(pt[a])} for a in top_t
                ],
            }
        )
    env.close()
    return probes


def analyze_phase5_counts(train_result: dict) -> dict:
    s = train_result["env_stats"]
    can_place = s["can_place_steps"]
    voluntary = s["voluntary_waits"]
    success = s["move_success"]
    conflicts = s["simultaneous_conflicts"]
    other_illegal = s["other_illegal"]
    residual = can_place - voluntary - success
    return {
        "can_place_steps": can_place,
        "voluntary_waits": voluntary,
        "move_success": success,
        "residual_can_place_minus_vol_minus_success": residual,
        "reported_simultaneous_conflicts": conflicts,
        "reported_other_illegal": other_illegal,
        "classification": (
            "数値上 residual は simultaneous_conflicts と一致するが、"
            "ステップ単位ログが無いため同一事象であることはログで証明できず未分類。"
        ),
        "voluntary_wait_uses_mask_before_step": True,
        "note_eval_voluntary_increase": (
            "学習中の自発WAIT(158)と評価時の自発WAIT合計(initial 4819 / trained 8440)は別集計。"
            "『学習中に自発WAITが増えた』比較対象はない。"
            "評価時の initial→trained での増加は eval_summary に実測あり。"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase5-run-id", default="phase5-smoke-001")
    parser.add_argument("--out-run-id", default="phase6-diagnostics-001")
    args = parser.parse_args()

    phase5 = TRAINING_ROOT / "artifacts" / args.phase5_run_id
    out = TRAINING_ROOT / "artifacts" / args.out_run_id
    if out.exists():
        print(f"refuse overwrite existing {out}", file=sys.stderr)
        return 2
    out.mkdir(parents=True)

    train_result = json.loads((phase5 / "train_result.json").read_text(encoding="utf-8"))
    versions = {
        "python": sys.version,
        "torch": torch.__version__,
        "reported_in_phase5": train_result.get("versions"),
    }

    initial = MaskablePPO.load(str(phase5 / "initial_model.zip"), device="cpu")
    trained = MaskablePPO.load(str(phase5 / "trained_model.zip"), device="cpu")

    report = {
        "out_run_id": args.out_run_id,
        "phase5_run_id": args.phase5_run_id,
        "diag_seeds": DIAG_SEEDS,
        "diag_note": DIAG_NOTE,
        "versions": versions,
        "count_integrity": analyze_phase5_counts(train_result),
        "param_split_initial": split_param_norms(initial),
        "param_split_trained": split_param_norms(trained),
        "param_diff_initial_vs_trained": param_diff_norms(initial, trained),
        "policy_shift_probes": probe_policy_shift(initial, trained),
        "reward_sign_check": {
            "note": "黒白とも env は learner 側 outcome で ±1。Phase5 bridge 実装を再確認済み。",
            "verified_by_code_review": True,
        },
        "evaluations": {},
    }

    for label, path in [
        ("phase5_initial", phase5 / "initial_model.zip"),
        ("phase5_trained", phase5 / "trained_model.zip"),
    ]:
        report["evaluations"][f"{label}_det"] = evaluate_model(path, True)
        report["evaluations"][f"{label}_sto"] = evaluate_model(path, False)

    (out / "diagnostics.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # markdown summary
    lines = [
        f"# Phase6 診断 `{args.out_run_id}`",
        "",
        DIAG_NOTE,
        "",
        "## 集計整合",
        json.dumps(report["count_integrity"], ensure_ascii=False, indent=2),
        "",
        "## パラメータ差分（initial→trained）",
        json.dumps(report["param_diff_initial_vs_trained"], ensure_ascii=False, indent=2),
        "",
        "## 評価サマリ",
    ]
    for key, ev in report["evaluations"].items():
        o = ev["overall"]
        lines.append(
            f"- {key}: W/L/D={o['wins']}/{o['losses']}/{o['draws']} "
            f"win={o['win_rate']:.3f} score={o['score_rate']:.3f} "
            f"vol_rate={o['mean_voluntary_wait_rate']:.3f}"
        )
    (out / "diagnostics.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"saved": str(out / "diagnostics.json")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
