# GA-1 初回実行記録

最終更新: 2026-09-13

PPO 成果物とは別: `training/ga_runs/<run-id>/`

## コマンド（Windows）

```bash
npm.cmd run test
npm.cmd run typecheck
npm.cmd run build

npm.cmd run ga:smoke
npm.cmd run ga:train
npm.cmd run ga:resume
npm.cmd run ga:evaluate -- --run-id ga1-train-001 --label final-best --seed 42
npm.cmd run ga:evaluate -- --run-id ga1-train-001 --label final-best --seed 42 --holdout
npx tsx src/ga/cli.ts evaluate --individual training/ga_runs/ga1-train-001/hall_of_fame/elite-g20-aklou8-arch.json --label cand-g20 --seed 42 --holdout
```

中断後の再開:

```bash
npm.cmd run ga:resume -- --run-id ga1-train-001
```

## 実測速度（GA 評価CPU込み）

- 本設定実行全体: **96000試合 / 約10407秒 ≈ 9.2 試合/秒**（壁時計）
- ログ上の途中表示はおおむね 4.5〜5.7 試合/秒（開始時点からの累計表示）
- Phase4 ベンチ速度とは別計測

## smoke（`ga1-smoke-001`）— 完了

| 項目 | 値 |
|------|-----|
| 設定 | 16体・3世代 |
| 実試合数 | 1440 |
| 最終選抜 best | 約0.823（パネル依存） |
| 保存先 | `training/ga_runs/ga1-smoke-001/` |

## 本設定 train（`ga1-train-001`）— 完了

| 項目 | 値 |
|------|-----|
| 設定 | 64体・50世代（generation 0〜49） |
| 選抜用実試合数 | **96000** |
| 安全上限 | 120000（未到達） |
| 壁時計 | 約 2.89 時間 |
| 最終選抜 best 得点率 | 0.865（パネル依存・成長指標にしない） |
| 遺伝子ユニーク数 | 各世代とも 64（完全同一遺伝子の崩壊なし） |
| 着手列ハッシュ重複率 | 約 0.03〜0.10 |
| 保存先 | `training/ga_runs/ga1-train-001/` |

### 世代内固定検証（学習中・10試合・選抜とは別）

| gen | scoreRate |
|-----|-----------|
| 0 | 0.80 |
| 5 | 0.80 |
| 10 | 1.00 |
| 15 | 0.80 |
| 20 | 1.00 |
| 25 | 1.00 |
| 30 | 0.95 |
| 35 | 0.70 |
| 40 | 1.00 |
| 45 | 0.90 |

※学習中の検証シード導出は当時の個体IDに依存。事後の `ga:evaluate` はラベル固定IDで再測する。

### 事後固定評価（seed=42、ラベル固定シード）

| 個体 | 固定検証 | holdout |
|------|----------|---------|
| hand-stone-g0（初期代表） | 0.75 | 0.55 |
| child-g10-2r4i2i-arch | 0.85 | 0.90 |
| **elite-g20-aklou8-arch（採用候補）** | **1.00** | **1.00** |
| child-g25-drd5fb-arch | 0.90 | 0.70 |
| child-g40-1x8tan-arch | 1.00 | 0.90 |
| child-g49-7b1kkn（最終世代代表） | 0.90 | 1.00 |

要約: **この固定相手セットでは**、初期石数重視より複数の保存個体が良い。  
採用候補は検証で良く、holdout でも崩れていない **elite-g20-aklou8-arch**。  
最終世代が最強とは限らない（gen35 の学習中検証 0.70 など）。  
試合数10と相手セットが狭いため、**一般的な強さ**や **PPOより優れる**とは言わない。

詳細 JSON: `training/ga_runs/ga1-train-001/eval-summary.json`

## 保存・再開・別ロード

- 自動テストで中断再開後の遺伝子・得点率が一致
- `hall_of_fame/*.json` を別プロセスで読み対戦可能
- 既存 hall は上書きしない
