from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from gymnasium.utils.env_checker import check_env

from ex_osero_rl.bridge import NodeBridge
from ex_osero_rl.env import ExtremeOthelloEnv, OBS_DIM, WAIT_ACTION


def test_bridge_ping() -> None:
    bridge = NodeBridge()
    bridge.start()
    data = bridge.request({"cmd": "ping"})
    assert data.get("pong") is True
    bridge.close()


def test_few_episodes() -> None:
    env = ExtremeOthelloEnv(
        cooldown_ms=700,
        think_delay_ms=500,
        use_matchup_schedule=True,
        schedule_seed=123,
    )
    obs, info = env.reset(seed=123)
    assert obs.shape == (OBS_DIM,)
    assert obs.dtype == np.float32
    mask = env.action_masks()
    assert mask.shape == (101,)
    assert bool(mask[WAIT_ACTION]) or np.any(mask)

    steps = 0
    for _ in range(3):
        obs, info = env.reset()
        done = False
        while not done:
            mask = env.action_masks()
            # 合法からランダム（WAIT 優先で短くしない）
            choices = np.flatnonzero(mask)
            action = int(np.random.choice(choices))
            obs, reward, terminated, truncated, info = env.step(action)
            steps += 1
            assert not (terminated and truncated and info.get("endReason") is None and truncated)
            done = terminated or truncated
            if terminated:
                assert abs(reward) in (0.0, 1.0)
        # 終局後は masks を呼ばない
    env.close()
    print(f"few_episodes_ok steps={steps} episodes={env.stats['episodes']}")


def test_check_env() -> None:
    env = ExtremeOthelloEnv(cooldown_ms=700, think_delay_ms=500)
    # check_env はマスク無視の行動も送る → 不正は不成立のまま
    check_env(env, skip_render_check=True)
    env.close()
    print("check_env_ok")


def test_parity_with_direct_ts() -> None:
    """同じ要求列で観測が安定していること（ブリッジ経由の決定性）。"""
    env = ExtremeOthelloEnv(cooldown_ms=700, think_delay_ms=0)
    obs1, _ = env.reset(
        options={"seed": 9, "learner_side": "black", "opponent": "random"}
    )
    actions = []
    for _ in range(20):
        mask = env.action_masks()
        # 置けるなら最初の合法、否则 WAIT
        place = np.flatnonzero(mask[:-1])
        action = int(place[0]) if len(place) else WAIT_ACTION
        actions.append(action)
        obs, reward, term, trunc, info = env.step(action)
        if term or trunc:
            break
    env.close()

    env2 = ExtremeOthelloEnv(cooldown_ms=700, think_delay_ms=0)
    obs2, _ = env2.reset(
        options={"seed": 9, "learner_side": "black", "opponent": "random"}
    )
    assert np.allclose(obs1, obs2)
    for a in actions:
        obs_a, _, term, trunc, _ = env2.step(a)
        if term or trunc:
            break
    env2.close()
    print("parity_ok")


def test_no_secret_in_obs_info_keys() -> None:
    env = ExtremeOthelloEnv()
    _, info = env.reset(options={"seed": 1, "learner_side": "black", "opponent": "random"})
    blob = json.dumps(info, default=str)
    assert "simultaneousPriority" not in blob
    env.close()
    print("no_secret_ok")


def main() -> int:
    test_bridge_ping()
    test_few_episodes()
    test_parity_with_direct_ts()
    test_no_secret_in_obs_info_keys()
    test_check_env()
    print("ALL_RL_CHECKS_PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
