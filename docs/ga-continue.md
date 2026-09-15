# GA 続き育成（第20世代 → 第50世代）

最終更新: 2026-09-14

現行アプリの第20世代代表を種に、世代21〜50を追加育成した。  
初回50世代ラン `ga1-train-001` の後半は固定検証で第20世代を上回らなかったため、同じ続きではなく **新しいラン** `ga1-train-002` とした。

## コマンド

```bash
npm.cmd run test
npm.cmd run typecheck

# 第21〜30世代
npm.cmd run ga:continue

# 第31〜40世代
npm.cmd run ga:continue:resume -- --generations 41

# 第41〜50世代
npm.cmd run ga:continue:resume -- --generations 51

# 10世代ごとの最強を評価して src/cpu/gaMilestones.ts に書く
npx tsx src/ga/cli.ts pick-milestone --run-id ga1-train-002 --generation 30 --id ga_g30 --write-cpu
npx tsx src/ga/cli.ts pick-milestone --run-id ga1-train-002 --generation 40 --id ga_g40 --write-cpu
npx tsx src/ga/cli.ts pick-milestone --run-id ga1-train-002 --generation 50 --id ga_g50 --write-cpu
```

## 結果（`ga1-train-002`）

| 項目 | 値 |
|------|-----|
| 種 | `elite-g20-aklou8-arch`（現行第20世代）ほか第10/15世代 |
| 世代 | 21〜50 |
| 選抜用試合数 | 57600（21〜50の30世代 × 1920） |
| アプリ導入 | 第20 / 30 / 40 / 50世代を選択可能 |

### 10世代ごとの採用個体（seed=42、対第20世代12試合を含む）

| 世代 | 個体 | 固定検証 | holdout | 対第20世代 |
|------|------|----------|---------|------------|
| 20 | elite-g20-aklou8-arch | 1.00 | 1.00 | （本人） |
| 30 | elite-g30-79fqeg | 0.917 | 0.917 | **1.00**（12戦全勝） |
| 40 | elite-g40-39k6uf | 0.917 | 0.917 | **1.00**（12戦全勝） |
| 50 | child-g50-3tkzmb | 0.917 | 0.917 | **1.00**（12戦全勝） |

デフォルトの `ga_best` は、対第20世代の得点率を優先し、同点なら新しい世代。現在は第50世代。

試合数が少なく相手セットが狭いため、**一般的な強さ**や人間に必ず勝つとは言わない。
