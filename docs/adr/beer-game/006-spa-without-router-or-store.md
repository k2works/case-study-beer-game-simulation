---
type: ADR
title: "ADR-006: フロントエンドは SPA とし、ルーターと状態管理ライブラリを導入しない"
description: "React の SPA とし、画面の切り替えと共有状態はコンポーネントの状態（useState）だけで扱う。"
tags: [adr]
status: draft
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-11-09T07:45:24Z }
---

# ADR-006: フロントエンドは SPA とし、ルーターと状態管理ライブラリを導入しない

React の SPA とし、画面の切り替えと共有状態はコンポーネントの状態（`useState`）だけで扱う。

日付: 2026-11-09

## ステータス

提案中（実装済みの決定を事後に記録したもの。レビュー待ち）

## コンテキスト

画面は 8 つ（はじめる、作成、参加・復帰、ロビー、プレイ、観察、振り返り、保持状態）で、`src/ui` は 11 ファイル・約 1,660 行。検索流入は不要で、学習セッション中の操作と状態更新が中心になる。画面をまたいで共有する状態は、ゲーム ID、セッション ID、進行役かどうかだけである。

- 参考: [フロントエンドアーキテクチャ](../../design/beer-game/architecture-frontend.md)

## 決定

- レンダリングは SPA（React 19 + Vite）とする。サーバーサイドレンダリングは使わない。
- URL ルーターを使わず、`App` の `page` 状態で画面を切り替える。
- グローバルな状態管理ライブラリ（Redux、Zustand など）を使わない。共有状態は `App` が持ち、サーバー状態は各画面が `BrowserApi` と `LiveStateAdapter` で扱う。
- スタイルは単一の `styles.css` とする。

### 変更箇所

- `apps/beer-game/src/ui/App.tsx`、`main.tsx`、`styles.css`
- `apps/beer-game/vite.config.ts`、`index.html`

### 代替案

- Next.js などの SSR/SSG: 検索流入が不要で、SPA の配信（静的ファイル）の方が単純。
- React Router の導入: URL で画面を直接開く要件がなく、依存が増える。ただし再読み込みでゲームを失う問題がある（影響を参照）。
- Redux や Zustand の導入: 共有状態が 4 つだけで、過剰。

## 影響

### ポジティブ

- 依存と構成が少なく、静的ファイルとして配信できる。
- `BrowserApi` を差し替えれば画面をテストできる。

### ネガティブ

- 画面を再読み込みすると、ゲーム ID とセッション ID を失う。参加者は復帰資格で戻れるが、進行役がコンソールへ戻る手段は画面にない（要確認）。
- 画面が増えると、`src/ui` のフラットな構成と大きなコンポーネント（`CreateJoinLobby.tsx` は約 415 行）が負担になる。

## コンプライアンス

- 画面が 10 を超える、または URL で直接開く要件が出た場合は、ルーターと機能単位の構成を再検討する。
- アクセシビリティ（キーボード、フォーカス、200% 拡大）のテストが通ること（`tests/u5/accessibility.test.tsx`、`tests/e2e/u5.spec.ts`）。

## 備考

- 著者: claude-code（事後記録）。承認者: 未定
- 関連コミット: 5355ed4（`App.tsx` の初版）。現在の構成は未コミット
- 関連 ADR: ADR-004、ADR-007
