# Auto Rebalance BOT (Uniswap V3 on Base)

GitHub Actions cron で 6時間ごとに動く自動リバランス BOT。
ETH価格がレンジ外れたら、自動で旧ポジションを解約 → 50:50スワップ → 新レンジで mint。
ウォレットに ETH/USDC 追加送金すると自動で LP に統合される。

## 月コスト

| 項目 | 金額 |
|---|---|
| GitHub Actions | $0 (無料枠 2,000分/月、本BOTは月120分使用) |
| RPC (Alchemy 無料枠) | $0 |
| ガス代 (Base) | 約 $1.5〜15 / 月(リバランス頻度次第) |

## 構成

```
auto-rebalance/
├── .github/workflows/rebalance.yml  ← 6h cron
├── src/
│   ├── rebalance.js                  ← メインロジック
│   ├── uniswap.js                    ← V3コントラクト操作
│   └── chatwork.js                   ← Chatwork通知
├── package.json
└── README.md
```

## セットアップ手順

### 1. BOT専用ウォレット作成

MetaMask で新規アカウント追加(右上の丸アイコン → アカウント作成)。
**メインウォレットは絶対に使わない**。秘密鍵は GitHub Secrets に置くため、漏洩リスクがゼロではない。

### 2. Alchemy 無料アカウント作成

https://www.alchemy.com → サインアップ → 「Create new app」
- Chain: **Base**
- Network: **Mainnet**

作成後、**HTTPS URL** をコピー(例: `https://base-mainnet.g.alchemy.com/v2/xxxxx`)。

### 3. Chatwork API トークン取得

https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php

通知を送るルームの **ルームID** も取得(URLの `/rid12345678` の数字部分)。

### 4. GitHub リポジトリ作成

```bash
cd C:\Users\ooxmi\Downloads\スワップツール\auto-rebalance
git init
git add .
git commit -m "initial commit"
gh repo create auto-rebalance --private --source=. --push
```

### 5. GitHub Secrets 登録

リポジトリの Settings → Secrets and variables → Actions → New repository secret

| 名前 | 値 |
|---|---|
| `BASE_RPC_URL` | Alchemyで取得したURL |
| `PRIVATE_KEY` | BOTウォレットの秘密鍵(0x付き) |
| `TOKEN_ID` | (空でOK、初回mint後に設定) |
| `CHATWORK_TOKEN` | ChatworkのAPIトークン |
| `CHATWORK_ROOM_ID` | 通知先ルームID |

### 6. 初回資金投入

BOTウォレットに以下を送金:

| 用途 | 推奨額 |
|---|---|
| ガス代備蓄 | **0.005 ETH** (Base) |
| 運用元金 | **ETH または USDC** で $69分 |

ETHのみ送ると、初回実行で半分がUSDCにスワップされて両方所持の状態になる。

### 7. 初回実行 (Dry Run)

GitHub の Actions タブ → 「Auto Rebalance」 → 「Run workflow」 → `dry_run: true` で実行。
ログで「DRY RUN」セクションを確認、エラーなければOK。

### 8. 本番実行

同じく「Run workflow」を `dry_run: false` で実行。
- 既存ポジションが無ければ → 新規 mint(NEW TOKEN_ID がログに出る)
- ログに出た `NEW TOKEN_ID` を **GitHub Secret `TOKEN_ID`** に登録

以後は6時間ごとに自動実行。

## コマンド (workflow_dispatch から選択)

GitHub Actions の「Run workflow」で `command` を選んで実行:

| コマンド | 動作 |
|---|---|
| `auto` | デフォルト。レンジ判定→必要時リバランス。6時間cronも同じ動作 |
| `status` | 現在のポジション・残高・価格をChatworkに通知のみ(TX送信なし) |
| `dry_run` | シミュレーションのみ実行、TX送信なし |
| `force_rebalance` | レンジ内でも強制的にリバランス実行 |
| `close_all` | 全ポジション解約してETH/USDCに戻す。WETHは自動unwrap |

cronで自動実行されるときは常に `auto`。手動実行のときだけ他のコマンド選べる。

## 環境変数(GitHub Variables で上書き可能)

| 変数 | デフォルト | 説明 |
|---|---|---|
| `RANGE_WIDTH_PCT` | 15 | レンジ幅(±%)、5=狭い、30=広い |
| `GAS_RESERVE_ETH` | 0.002 | ガス代用に残す ETH |
| `MIN_REBALANCE_USD` | 30 | この金額未満の残高は無視 |
| `NOTIFY_SKIP` | false | レンジ内スキップ時も通知するか |

## 入金で自動拡大

BOTウォレットに ETH か USDC を追加送金するだけ。次の cron 実行(最大6時間後)で:
1. 残高検知
2. 既存ポジションが**レンジ内** → `increaseLiquidity` で追加
3. 既存ポジションが**レンジ外** → 全部統合してリバランス

## 出金

GitHub Actions を無効化 → BOTウォレットから手動でメインに送金。
または LP を解約してから送金(別途スクリプト未実装、必要なら追加)。

## トラブルシュート

- **"Gas reserve too low"** → BOTウォレットに ETH 追加
- **"Final balance too small to mint LP"** → 元金少なすぎ、$50以上推奨
- **TX revert** → ガス代不足、スリッページ、流動性枯渇のいずれか。Chatwork通知で詳細確認

## 注意

- 元金 $69 規模では年間赤字の可能性大(ガス代 vs 利益)
- 元金 $500 以上が黒字化目安
- BOTウォレット秘密鍵は GitHub Secrets に保存、漏洩したら全資金失う
- スマートコントラクトリスク(Uniswap V3 自体は枯れているが、ゼロではない)
- Impermanent Loss(価格変動で単純保有より損する場合あり)

## 元コード参照

`../uniswap-v3-automan/` (Aperture Finance のオンチェーン版自動化コントラクト)
本BOTはそのオフチェーン簡易版(OptimalSwap計算は50:50固定で簡略化)。
