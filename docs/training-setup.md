# 学習環境セットアップ

最終更新: 2026-09-13

## 必要なもの

| 項目 | 今回の導入結果 |
|------|----------------|
| Python | **3.12.10**（ユーザー領域に winget で導入） |
| 仮想環境 | プロジェクト直下 `.venv` |
| PyTorch | **2.14.0+cpu**（CUDA なし） |
| Gymnasium | **1.1.1** |
| Stable-Baselines3 | **2.6.0** |
| sb3-contrib | **2.6.0** |
| NumPy | **2.2.6** |

依存のピン留め: `training/requirements.txt`  
実インストールの凍結: `training/requirements-lock.txt`

GPU / CUDA / クラウドは使いません。`device=cpu` 固定です。

---

## Python が無い場合（ユーザー操作）

本機では当初 Python が未導入でした。公式の Python 3.12 を **ユーザー範囲** で入れます（システム全体設定の変更は不要）。

1. [Python 3.12 Windows installer](https://www.python.org/downloads/release/python-31210/) を入手する  
   または: `winget install Python.Python.3.12 --scope user -e`
2. インストール後、次をプロジェクトで実行:

```bat
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python.exe -m pip install -r training\requirements.txt
```

実行ポリシーは変更しません。仮想環境の有効化スクリプトに頼らず、`.venv\Scripts\python.exe` を直接呼び出します。

---

## 接続方式

- Python が常駐 Node 子プロセス（`src/sim/rlBridge.ts`）と **JSON Lines** で通信
- 試合 `reset` ではプロセスを再起動しない
- stdout = JSON 応答専用 / 診断は stderr
- ゲームルールは TypeScript のまま（Python へコピーしない）

---

## コマンド

```bat
npm.cmd run rl:check
npm.cmd run rl:train:smoke
npm.cmd run rl:evaluate -- --run-id <run-id>
```

例:

```bat
npm.cmd run rl:train:smoke -- --run-id phase5-smoke-001
npm.cmd run rl:evaluate -- --run-id phase5-smoke-001
```

成果物: `training/artifacts/<run-id>/`（`.gitignore` 対象）

---

## Git 注意

`.venv/`、`training/artifacts/`、`*.zip` はコミットしない。  
ドキュメント上の数値は `docs/training-first-run.md` に要約を残す。
