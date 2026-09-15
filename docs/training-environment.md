# 学習用対戦環境

仕様バージョン: **1.0.0**（`TRAINING_SPEC_VERSION`）

最終更新: 2026-09-13

本ドキュメントは、画面なしで CPU／学習処理がゲームと接続するための観測・行動・時間・報酬・終了の定義である。  
ゲームルール本体は `src/game/` を直接利用し、別言語へのルールコピーは行わない。

---

## 1. 位置づけ

| 項目 | 内容 |
|------|------|
| 目的 | 将来の強化学習から状態取得と行動入力ができること |
| 今回の完成範囲 | CPU 同士の自動対戦、観測／行動／マスク／報酬 API、**Gymnasium + MaskablePPO 接続（Phase 5）** |
| 今回やらないこと | 長時間自己対戦育成、GPU、ブラウザへの学習モデル組み込み、ONNX、20 段階 |

ブラウザ版との関係:

- 盤面・クールタイム・同時着手・終了は `stepMatch` と共通。
- 開始カウントダウンは省略する。開始状態は `createMatch` 直後＝ブラウザのカウントダウン終了直後と一致。
- `requestAnimationFrame` やフレーム上限・大きな `dt` 破棄は持ち込まない。固定 50ms ステップを必要な回数だけ進める。

---

## 2. 時間条件（最新仕様）

| 設定 | 値 | 備考 |
|------|-----|------|
| クールタイム（標準） | **700 ms** | 着手成功後。ブラウザ試作と同じ |
| CPU 判断待ち | **500 ms** | 着手可能かつ合法手がある状態からの待ち。クールタイムとは別 |
| 固定ステップ | 50 ms | |
| 試合時間 | 180000 ms | 到達時は正式な `time_up`（terminated） |

自動対戦の比較では、双方に同じクールタイムと判断待ちを適用する。  
これは時間条件を揃えた判断方法の比較であり、**対人勝率ではない**。

---

## 3. 行動

| 値 | 意味 |
|----|------|
| 0〜99 | マスに置く。`index = row * 10 + col`（回転・座標入替なし） |
| 100 | WAIT。この 50ms ステップでは置かない |

WAIT は相手への手番渡しではない。待っている間も相手は行動でき、双方のゲーム内時間が進む。

---

## 4. 行動マスク（長さ 101 の boolean）

`true` = 選択可能、`false` = 選択不可。

- マスが `true` になる条件: そのマスが合法手 **かつ** クールタイム 0 **かつ** 適用中の判断待ちが終了している。
- 着手できない間は WAIT のみ `true`。
- 着手できるときも WAIT を選べる。
- 終局後（`phase !== 'playing'`）はすべて `false`。終局後に着手処理を進めない。

盤面上の合法手一覧と、「今選べる行動」は別物である（時間条件を含む）。

マスク外の着手が渡された場合も、既存 `stepMatch` どおり盤面・クールタイムは不正に変えず、未終局なら時間は進む。  
同時着手で後手が不成立になった場合も、クールタイムは消費しない。

---

## 5. 観測（自分／相手視点）

`getSideObservation` / `SideObservation`（JSON 化可能）。

| フィールド | 型 | 単位・範囲 | 説明 |
|------------|-----|------------|------|
| `specVersion` | string | — | 本仕様バージョン |
| `side` | `"black"` \| `"white"` | — | 担当側 |
| `board` | number[100] | `-1` / `0` / `1` | 行優先。1=自分、-1=相手、0=空き |
| `myCooldownMs` | number | ms, ≥0 | 自分の残りクールタイム |
| `opponentCooldownMs` | number | ms, ≥0 | 相手の残りクールタイム |
| `remainingMatchMs` | number | ms, 0〜180000 | 残り試合時間 |
| `myThinkRemainingMs` | number \| null | ms | 自分の判断待ち残り。非待ちは null |
| `phase` | string | — | playing / paused / finished |
| `cooldownMs` | number | ms | この試合のクールタイム設定 |
| `thinkDelayMs` | number | ms | この側の判断待ち設定 |

### 正規化ベクトル（`toNormalizedVector`）

長さ **104**、順序固定:

1. `board[0..99]`（既に -1/0/1）
2. `myCooldownMs / cooldownMs`（0〜1 付近）
3. `opponentCooldownMs / cooldownMs`
4. `remainingMatchMs / matchDurationMs`
5. 判断待ち中なら `myThinkRemainingMs / max(thinkDelayMs,1)`、否则 `0`

### 含めない情報（非公開）

- 相手の未確定入力
- 相手がこれから選ぶマス
- 乱数内部状態
- 相手の判断待ち内部状態
- `simultaneousPriority`（UI にも出していないため学習観測にも出さない）
- 試合シード（デバッグ用 MatchState 側）

デバッグ用の `MatchState` と学習用観測は分離する。

---

## 6. 報酬と終了

| 結果 | 報酬（その側） |
|------|----------------|
| 勝利 | +1 |
| 敗北 | -1 |
| 引き分け | 0 |
| 試合途中 | 0 |

終局報酬はその試合で一度だけ。石返しごとの追加報酬は置かない。

### terminated（ゲーム本来の終了）

- 盤面が埋まる（`board_full`）
- 双方に合法手がない（`no_legal_moves`）
- 制限時間 180 秒（`time_up`）— 正式ルール

### truncated（ルール外の安全中断）

- ステップ数が安全上限（既定 10000）に達したとき
- **正常な引き分けとして勝率に混ぜない**

---

## 7. API 概要（TypeScript）

モジュール: `src/sim/`

```ts
const env = createTrainingEnv({
  seed,
  cooldownMs: 700,
  blackThinkDelayMs: 500,
  whiteThinkDelayMs: 500,
})

env.getObservation('black')
env.getActionMask('black')
env.step(blackAction, whiteAction) // 双方入力後に 1 固定ステップ
env.getRewards()
```

CPU 同士: `runCpuMatch({ agents: { black, white }, ... })`  
双方の行動は同一公開盤面から生成し、黒→白の順で乱数を消費してから `step` する。

---

## 8. 実行コマンド

```bash
npm.cmd run sim:smoke       # 画面なし・少数試合
npm.cmd run sim:benchmark   # 4組み合わせ×25試合
npm.cmd run rl:check        # Python接続・Gymnasium検査
npm.cmd run rl:train:smoke  # MaskablePPO 32768 ステップ試験学習
npm.cmd run rl:evaluate -- --run-id <run-id>
```

Python 側のセットアップは `docs/training-setup.md`、最初の学習実測は `docs/training-first-run.md`。

### Gymnasium 接続メモ

- 既定（Phase5互換）: 1 Gym step = ゲーム内 50ms
- 追加モード（`compressForcedWait` / 仕様版 `1.1.0-compress-forced-wait`）:
  1 Gym step = 学習側の判断可能行動1回 + 必要なら強制WAIT区間の連続50ms処理
  （盤面ルール・観測104次元・報酬定義は変更なし）
- 観測は `toNormalizedVector` の 104 次元 float32（項目順は §5）
- 学習側と相手 CPU の行動は同一公開盤面から生成し、既存の同時着手へ渡す
- 詳細: `docs/training-setup.md` / `docs/training-phase6.md`
