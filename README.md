# エクストリームオセロ（仮称）

ブラウザで動く 10×10 リアルタイム型リバーシの試作です。相手の手番を待たず、行動ゲージが回復したら着手できます。

## 遊ぶ

公開ページをブラウザで開くと、インストールなしで遊べます。友達にもこの URL を送ってください。オンライン対戦にはなりません。各自が CPU と戦います。

https://salsnoah.github.io/ex-reversi/

手元で動かす場合は、下のセットアップを使います。Windows では `play.bat` をダブルクリックしても起動できます。

## 必要環境

- Node.js 22 以降推奨（開発時は Node.js 24 で確認）
- npm
- RL を動かす場合: Python 3.12 とプロジェクト内 `.venv`（`docs/training-setup.md`）

## セットアップ

```bash
npm.cmd install
```

## よく使うコマンド

```bash
npm.cmd run dev           # 開発サーバー（タイトルで「GA育成（第20世代代表）」と対戦可）
npm.cmd run test          # Vitest を1回実行して終了
npm.cmd run typecheck     # TypeScript 型検査
npm.cmd run build         # 本番ビルド
npm.cmd run sim:smoke     # 画面なし・少数試合の動作確認
npm.cmd run sim:benchmark # 画面なし・4組み合わせ×25試合の集計
npm.cmd run rl:check
npm.cmd run rl:train:smoke -- --run-id <new-run-id>
npm.cmd run rl:evaluate -- --run-id <run-id>
npm.cmd run rl:diagnose
npm.cmd run rl:speed
npm.cmd run rl:train:phase6
npm.cmd run rl:evaluate:phase6
npm.cmd run ga:smoke
npm.cmd run ga:train
npm.cmd run ga:resume
npm.cmd run ga:evaluate -- --run-id ga1-train-001 --label best --seed 42
```

RL のセットアップは `docs/training-setup.md`。  
Phase5 実測: `docs/training-first-run.md` / 診断: `docs/training-diagnostics.md` / Phase6: `docs/training-phase6.md`。  
GA-1: `docs/ga-design.md` / 初回実行: `docs/ga-first-run.md`。

既存の `training/artifacts/<run-id>/` と `training/ga_runs/<run-id>/` はデフォルトで上書きしません（別 run-id を使う）。

`sim:*` の追加引数例:

```bash
npx tsx src/sim/cli.ts smoke --seed-base 1000
npx tsx src/sim/cli.ts benchmark --matches 25 --seed-base 1000
```

結果は `docs/benchmark-output/`（sim）または `training/artifacts/<run-id>/`（rl）に書き出されます。

開発サーバー起動後は通常 `http://localhost:5173/` を開きます。  
ポートが使用中の場合は Vite が `5174` など別ポートを案内します。

## 構成

- `src/game/` … 盤面ルール・時間・同時着手（React 非依存）
- `src/cpu/` … 差し替え可能な簡易 CPU（ランダム型 / 即時反転数優先型）
- `src/session/` … カウントダウン・CPU判断待ち・入力の試合進行
- `src/sim/` … 画面なし対戦・学習用入出力・自動対戦・RL ブリッジ
- `src/ga/` … GA-1（評価係数遺伝子の遺伝的アルゴリズム育成）
- `training/` … Python Gymnasium / MaskablePPO、および `ga_runs/`
- `src/ui/` … 画面表示

仕様は `docs/game-spec.md`、進捗は `docs/progress.md` を参照してください。

## メモ

- Windows では実行ポリシーの都合で `npm.cmd` の利用を推奨します。
- npm の `Unknown env config "devdir"` 警告が出ることがありますが、現状の動作には影響していません。
