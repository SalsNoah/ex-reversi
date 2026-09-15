from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BRIDGE_SCRIPT = PROJECT_ROOT / "src" / "sim" / "rlBridge.ts"


class BridgeError(RuntimeError):
    pass


class NodeBridge:
    """常駐 Node 子プロセスとの JSON Lines 通信。"""

    def __init__(
        self,
        project_root: Path | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self.project_root = Path(project_root or PROJECT_ROOT)
        self.timeout_s = timeout_s
        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._stderr_thread: threading.Thread | None = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> None:
        if self.alive:
            return
        bridge = DEFAULT_BRIDGE_SCRIPT
        # Prefer local tsx from node_modules
        tsx_cmd = self.project_root / "node_modules" / ".bin" / "tsx.cmd"
        if tsx_cmd.exists():
            # Windows: .cmd は shell 経由、または node で tsx/cli を直接実行
            import sys as _sys

            if _sys.platform == "win32":
                import importlib.util

                # node_modules/tsx/dist/cli.mjs 相当を node で起動
                tsx_cli = self.project_root / "node_modules" / "tsx" / "dist" / "cli.mjs"
                if tsx_cli.exists():
                    cmd = ["node", str(tsx_cli), str(bridge)]
                else:
                    cmd = ["cmd.exe", "/c", str(tsx_cmd), str(bridge)]
            else:
                cmd = [str(tsx_cmd), str(bridge)]
        else:
            cmd = ["npx.cmd", "tsx", str(bridge)] if os.name == "nt" else ["npx", "tsx", str(bridge)]

        self._proc = subprocess.Popen(
            cmd,
            cwd=str(self.project_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True
        )
        self._stderr_thread.start()
        # readiness: send ping
        self.request({"cmd": "ping"})

    def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        for line in self._proc.stderr:
            # 診断は stderr のまま親にも出す
            print(line, end="", file=__import__("sys").stderr)

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if not self.alive:
                raise BridgeError("bridge process is not running")
            assert self._proc is not None
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None

            req_id = self._next_id
            self._next_id += 1
            message = {"id": req_id, **payload}
            line = json.dumps(message, ensure_ascii=False)
            try:
                self._proc.stdin.write(line + "\n")
                self._proc.stdin.flush()
            except BrokenPipeError as exc:
                raise BridgeError("failed to write to bridge") from exc

            deadline = time.monotonic() + self.timeout_s
            while time.monotonic() < deadline:
                if self._proc.poll() is not None:
                    raise BridgeError(
                        f"bridge exited with code {self._proc.returncode}"
                    )
                # readline with timeout via polling
                ready = self._proc.stdout.readline()
                if ready == "":
                    time.sleep(0.01)
                    continue
                try:
                    data = json.loads(ready)
                except json.JSONDecodeError as exc:
                    raise BridgeError(f"invalid JSON from bridge: {ready!r}") from exc
                if data.get("id") != req_id:
                    continue
                if not data.get("ok", False):
                    raise BridgeError(data.get("error", "bridge error"))
                return data
            raise BridgeError(f"timeout waiting for response id={req_id}")

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            if self._proc.poll() is None:
                try:
                    self.request({"cmd": "close"})
                except BridgeError:
                    pass
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
        finally:
            self._proc = None
