# Phase 6 記録

最終更新: 2026-09-13

**区別:**

1. **効率は改善した**（強制WAIT圧縮でゲーム内時間スループット約5.5倍、実測）
2. **今回の検証成績は det で Phase5 trained より良い傾向**（20試合、傾向確認のみ）
3. **一般に強くなったとは断定しない**

Phase5 成果物 `phase5-smoke-001` は上書きしていない。

---

## 成果物 run-id

| run-id | 内容 |
|--------|------|
| phase6-diagnostics-001 | 診断・det/sto 比較 |
| phase6-speed-001 | 速度比較 |
| phase6-retrain-001 | 圧縮モード再学習 16384 |

---

## 強制WAIT圧縮

- 学習環境版: `1.1.0-compress-forced-wait`（盤面ルール・観測104次元は変更なし）
- Node 内で WAITのみ区間を50ms単位で連続処理し、判断可能／終局で返す
- 自発WAITは1×50msで返す（罰則なし）
- 一致テスト: `src/sim/compressParity.test.ts`（Vitest 成功）
- gamma=1.0 のまま区間報酬を合計。将来 gamma&lt;1 なら時間割引が必要（未実施）

---

## 速度（同一 initial モデル、各4試合）

| | 従来50ms | 圧縮 |
|--|----------|------|
| 壁時計 | 14.61s | 2.65s |
| 試合/s | 0.27 | 1.51 |
| ゲーム内ms/s | 2.27e4 | 1.25e5 |
| 推論回数 | 6640 | 748 |

比（compress/fine）≈ **5.51**（ゲーム内時間・試合とも）。  
環境steps/s は単位が違うため同列比較しない。

---

## 再学習 `phase6-retrain-001`

- 初期重み: Phase5 `initial_model.zip`（差分 L2=0、optimizer 新規）
- 環境ステップ **16384**（≠着手回数、≠内部50ms）
- 内部50ms: 314028 / 強制WAIT自動: 297644
- 完了試合: **325**（random/max_flip・黒白ほぼ均等）
- 着手可能判断: 14654 / 自発WAIT: 1418 / 着手成功: 13032
- 壁時計: 159.4s / NaN・Infなし
- action_net L2: 0.10→1.09 / value_net L2: 21.56→21.62
- checkpoint-every 8192（DummyVecEnv 経由で保存。採用は最終16384のみ）

---

## 検証評価（シード5000-5004、各20試合／方式）

| モデル | det 勝率 | sto 勝率 |
|--------|----------|----------|
| phase5 initial | 0.250 | 0.350 |
| phase5 trained | 0.000 | 0.400 |
| phase6 trained | 0.450 | 0.550 |

良い方式だけ抜き出していない。傾向確認。最終評価用シードは別途確保すること。

---

## コマンド

```bat
npm.cmd run rl:diagnose
npm.cmd run rl:speed
npm.cmd run rl:train:phase6
npm.cmd run rl:evaluate:phase6
```
