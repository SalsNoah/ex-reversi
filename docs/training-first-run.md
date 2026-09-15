# 最初の試験学習ラン記録

最終更新: 2026-09-13  
run-id: **phase5-smoke-001**

本記録は実測に基づく。未実行を実行済みとは書かない。

**区別:**

1. 学習処理は実際に動いた（32768 ステップ完走・モデル保存・再読込成功）。
2. 今回の 40+40 試合評価では、学習後の成績は改善していない（悪化）。
3. 一般に強くなったとは言えない。

設定は動作確認用であり、最適値ではない。

---

## 環境

| 項目 | 値 |
|------|-----|
| Python | 3.12.10 |
| torch | 2.14.0+cpu |
| gymnasium | 1.1.1 |
| stable-baselines3 / sb3-contrib | 2.6.0 / 2.6.0 |
| クールタイム / 判断待ち / ステップ / 制限 | 700ms / 500ms / 50ms / 180s |
| 観測次元 | 104 float32（board100 + 正規化4） |
| アルゴリズム | MaskablePPO + MlpPolicy（128×2） |
| device | cpu、並列1 |

成果物パス（ローカル、gitignore）:

- `training/artifacts/phase5-smoke-001/initial_model.zip`
- `training/artifacts/phase5-smoke-001/trained_model.zip`
- `training/artifacts/phase5-smoke-001/train_result.json`
- `training/artifacts/phase5-smoke-001/eval_result.json`
- `training/artifacts/phase5-smoke-001/reload_verify.json`

---

## 学習実測

| 指標 | 値 |
|------|-----|
| 実学習ステップ数 | **32768**（着手回数でも試合数でもない） |
| 完了試合数（reset 回数） | **34** |
| 相手内訳 | random 18 / max_flip 16 |
| 担当色内訳 | black 17 / white 17 |
| 壁時計 | **344.3 s** |
| Python 接続後の処理速度 | **約 95.2 steps/s**（Phase4 の TS 直接 ~11385 steps/s とは別） |
| 着手可能ステップ | 1535 |
| WAIT のみステップ | 31233 |
| 自発的 WAIT | 158 |
| 着手成功 | 1356 |
| 同時着手競合不成立 | 21 |
| 競合以外の不正要求 | 0 |
| NaN / Inf | なし |
| パラメータ L2 変化 | 61.94 → 64.31（変化あり） |

学習ログ上の損失例（最終 iteration 付近）: `loss≈0.020`、`value_loss≈0.30`、`entropy_loss≈-0.12`。

---

## 再読み込み

- 別ロードのモデルで、初期・待機寄り・時間進行後の複数状態について `deterministic=True` の行動が一致（`reload_verify.json`）。
- 読込後に対戦を最後まで完走（異常終了なし）。

---

## 学習前後評価（同条件 80 試合）

評価シード: 5000〜5009（学習スケジュールとは別）。  
各モデル 40 試合（対 random 20 + 対 max_flip 20、各シードで黒白）。

| モデル | 勝/負/分 | 勝率 | 得点率 | 平均石差 | 異常 |
|--------|----------|------|--------|----------|------|
| initial | 8/30/2 | 0.200 | 0.225 | -16.38 | 0 |
| trained | 1/39/0 | 0.025 | 0.025 | -34.92 | 0 |

条件別（trained）はほぼ全敗。評価時の自発的 WAIT 合計は初期 4819 → 学習後 8440（評価ログの実測）。  
学習中の自発WAIT(158)との直接比較対象はない。短い試験学習＋deterministic 評価では有用な着手方策に見えない。

将来の最終評価には、この検証シード群とは別のシードを確保すること。

---

## 再実行

```bat
npm.cmd run rl:check
npm.cmd run rl:train:smoke -- --run-id phase5-smoke-001
npm.cmd run rl:evaluate -- --run-id phase5-smoke-001
```
