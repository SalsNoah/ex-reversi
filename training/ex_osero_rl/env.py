from __future__ import annotations

from typing import Any, SupportsFloat

import numpy as np
from gymnasium import Env, spaces
from gymnasium.utils import seeding

from .bridge import BridgeError, NodeBridge

OBS_DIM = 104
ACTION_N = 101
WAIT_ACTION = 100

# docs/training-environment.md の正規化ベクトル順
OBS_LAYOUT = (
    "board[0..99]: 1=self, -1=opponent, 0=empty; "
    "myCooldown/cooldownMs; opponentCooldown/cooldownMs; "
    "remainingMatch/matchDuration; thinkRemaining/thinkDelayOr0"
)


class ExtremeOthelloEnv(Env):
    """
    学習側1エージェント vs 固定簡易CPU。
    Gymnasium 1 step = ゲーム内 50ms。
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        bridge: NodeBridge | None = None,
        cooldown_ms: int = 700,
        think_delay_ms: int = 500,
        default_opponent: str = "random",
        default_learner_side: str = "black",
        schedule_seed: int | None = None,
        use_matchup_schedule: bool = False,
        compress_forced_wait: bool = False,
    ) -> None:
        super().__init__()
        self.bridge = bridge or NodeBridge()
        self._owns_bridge = bridge is None
        self.cooldown_ms = cooldown_ms
        self.think_delay_ms = think_delay_ms
        self.default_opponent = default_opponent
        self.default_learner_side = default_learner_side
        self.use_matchup_schedule = use_matchup_schedule
        self.compress_forced_wait = compress_forced_wait
        self._schedule_seed = schedule_seed
        self._schedule_rng: np.random.Generator | None = None
        self._episode_index = 0

        self.observation_space = spaces.Box(
            low=-1.0,
            high=1.0,
            shape=(OBS_DIM,),
            dtype=np.float32,
        )
        self.action_space = spaces.Discrete(ACTION_N)

        self._obs = np.zeros(OBS_DIM, dtype=np.float32)
        self._mask = np.zeros(ACTION_N, dtype=bool)
        self._mask[WAIT_ACTION] = True
        self._terminated = False
        self._truncated = False
        self._last_info: dict[str, Any] = {}
        self._match_seed: int | None = None
        self._learner_side = default_learner_side
        self._opponent = default_opponent

        # stats for logging
        self.stats = {
            "episodes": 0,
            "steps": 0,
            "internal_50ms_steps": 0,
            "can_place_steps": 0,
            "wait_only_steps": 0,
            "voluntary_waits": 0,
            "forced_wait_auto_steps": 0,
            "move_success": 0,
            "simultaneous_conflicts": 0,
            "other_illegal": 0,
            "by_opponent": {"random": 0, "max_flip": 0},
            "by_side": {"black": 0, "white": 0},
        }

    def _ensure_bridge(self) -> None:
        if not self.bridge.alive:
            self.bridge.start()

    def _parse_response(self, data: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
        obs = np.asarray(data["observation"], dtype=np.float32)
        mask = np.asarray(data["actionMask"], dtype=bool)
        if obs.shape != (OBS_DIM,):
            raise BridgeError(f"bad obs shape {obs.shape}")
        if mask.shape != (ACTION_N,):
            raise BridgeError(f"bad mask shape {mask.shape}")
        self._obs = obs
        self._mask = mask
        self._terminated = bool(data.get("terminated", False))
        self._truncated = bool(data.get("truncated", False))
        self._last_info = dict(data.get("info") or {})
        return self._obs, self._mask

    def _next_matchup(self, options: dict[str, Any] | None) -> tuple[str, str, int]:
        options = options or {}
        if "opponent" in options and "learner_side" in options:
            opponent = str(options["opponent"])
            side = str(options["learner_side"])
        elif self.use_matchup_schedule:
            assert self._schedule_rng is not None
            # 4条件を再現可能な順で繰り返す: (opp, side) 周期
            cycle = [
                ("random", "black"),
                ("random", "white"),
                ("max_flip", "black"),
                ("max_flip", "white"),
            ]
            opponent, side = cycle[self._episode_index % 4]
        else:
            opponent = str(options.get("opponent", self.default_opponent))
            side = str(options.get("learner_side", self.default_learner_side))

        if "seed" in options:
            match_seed = int(options["seed"])
        elif self._schedule_rng is not None:
            match_seed = int(self._schedule_rng.integers(0, 2**31 - 1))
        else:
            match_seed = int(self._episode_index)

        return opponent, side, match_seed

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        super().reset(seed=seed)
        self._ensure_bridge()

        # 試合条件用 RNG（ゲーム内部乱数と分離）
        if seed is not None or self._schedule_rng is None:
            base = seed if seed is not None else self._schedule_seed
            self._schedule_rng, _ = seeding.np_random(base)

        opponent, side, match_seed = self._next_matchup(options)
        self._opponent = opponent
        self._learner_side = side
        self._match_seed = match_seed

        data = self.bridge.request(
            {
                "cmd": "reset",
                "seed": match_seed,
                "learnerSide": side,
                "opponent": opponent,
                "cooldownMs": self.cooldown_ms,
                "thinkDelayMs": self.think_delay_ms,
                "compressForcedWait": self.compress_forced_wait,
            }
        )
        obs, mask = self._parse_response(data)
        self._episode_index += 1
        self.stats["episodes"] += 1
        self.stats["by_opponent"][opponent] = (
            self.stats["by_opponent"].get(opponent, 0) + 1
        )
        self.stats["by_side"][side] = self.stats["by_side"].get(side, 0) + 1

        info = {
            **self._last_info,
            "action_mask": mask.copy(),
            "match_seed": match_seed,
            "learner_side": side,
            "opponent": opponent,
        }
        return obs.copy(), info

    def action_masks(self) -> np.ndarray:
        """最新 step/reset 応答のマスク（追加通信なし）。"""
        if self._terminated or self._truncated:
            # 終局後の全 false を行動選択へ渡さない（呼び出し側で reset）
            raise RuntimeError("action_masks called after episode end")
        return self._mask.copy()

    def step(
        self, action: Any
    ) -> tuple[np.ndarray, SupportsFloat, bool, bool, dict[str, Any]]:
        if self._terminated or self._truncated:
            raise RuntimeError("step called after episode end; call reset()")
        self._ensure_bridge()

        can_place = bool(np.any(self._mask[:-1]))
        wait_only = bool(self._mask[WAIT_ACTION] and not can_place)
        self.stats["steps"] += 1
        if can_place:
            self.stats["can_place_steps"] += 1
        if wait_only:
            self.stats["wait_only_steps"] += 1
        if can_place and int(action) == WAIT_ACTION:
            self.stats["voluntary_waits"] += 1

        data = self.bridge.request({"cmd": "step", "action": int(action)})
        obs, mask = self._parse_response(data)
        reward = float(data.get("reward", 0.0))
        terminated = self._terminated
        truncated = self._truncated

        internal = int(data.get("internalSteps") or data.get("info", {}).get("internalSteps") or 1)
        forced_auto = int(
            data.get("forcedWaitAutoSteps")
            or data.get("info", {}).get("forcedWaitAutoSteps")
            or 0
        )
        self.stats["internal_50ms_steps"] += internal
        self.stats["forced_wait_auto_steps"] += forced_auto

        info = dict(data.get("info") or {})
        info["internalSteps"] = internal
        info["forcedWaitAutoSteps"] = forced_auto
        info["advancedMs"] = int(
            data.get("advancedMs") or info.get("advancedMs") or internal * 50
        )
        if info.get("moveSuccess") or info.get("applied"):
            self.stats["move_success"] += 1
        if info.get("simultaneousConflict"):
            self.stats["simultaneous_conflicts"] += 1
        elif (
            info.get("rejectReason")
            and int(action) != WAIT_ACTION
            and not info.get("applied")
        ):
            self.stats["other_illegal"] += 1

        info["action_mask"] = mask.copy()
        if terminated or truncated:
            info["terminal_observation"] = obs.copy()

        return obs.copy(), reward, terminated, truncated, info

    def close(self) -> None:
        if self._owns_bridge:
            self.bridge.close()
        return super().close()
