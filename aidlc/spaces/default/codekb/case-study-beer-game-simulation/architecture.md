# Architecture

## Architecture Analysis

### System Overview

現在のリポジトリは、ビールゲーム要件ドキュメントと Node.js ベースのドキュメント運用ツールから構成されます。ビールゲーム本体のランタイムアーキテクチャは未実装です。将来のアプリケーション領域として `apps/beer-game/` が確保されています。

### Architectural Style

現状は「ドキュメント中心の単一リポジトリ」です。Gulp が運用タスクの入口となり、`ops/scripts/` の機能別モジュールへ委譲します。対象アプリは実質 greenfield であり、要件から特定の Web アーキテクチャを実装済みと判断できる証拠はありません。

### Component Relationships

```mermaid
flowchart LR
  Developer["開発者"] --> Npm["npm / Gulp"]
  Npm --> Ops["ops/scripts"]
  Ops --> MkDocs["MkDocs / Docker"]
  Ops --> Manual["Manual HTML builder"]
  Ops --> Quality["SonarQube / OKF"]
  Requirements["Beer Game requirements"] --> FutureApp["apps/beer-game (未実装)"]
  FutureApp -. "今後実装" .-> Participants["進行役・参加者・観察者"]
```

<!-- Text fallback: 開発者は npm/Gulp から運用スクリプトを実行し、MkDocs、マニュアル生成、品質管理を利用する。要件文書は未実装の apps/beer-game に入力され、将来は利用者へサービスを提供する。 -->

### Data Flow

現時点でビールゲームの実データフローはありません。要件上は、進行役が設定と需要系列を登録し、参加者の意思決定が注文・生産遅延へ入り、全役割の入力完了後に週次状態を一度だけ確定し、終了後に分析結果へ投影する流れが必要です。

### Key Design Decisions

- Node.js ESM は運用ツールに採用済みですが、対象アプリへの採用決定ではありません。
- ドキュメントは MkDocs と GitHub Actions で公開できます。
- アプリ本体は既存運用ツールと分離して `apps/beer-game/` に配置する余地があります。

### Improvement Opportunities

- ドメイン計算を副作用のない決定論的コアとして分離する。
- 週確定をトランザクションと冪等キーで保護する。
- 役割別認可と情報投影をサーバー境界で強制する。
- リアルタイム画面更新と永続化を交換可能なアダプターに分離する。
- 要件 ID とテストを結び付ける。

## Interaction Diagrams

```mermaid
sequenceDiagram
  participant P as 参加者
  participant UI as 役割別 UI
  participant API as ゲーム API
  participant Core as 週次計算コア
  participant DB as 永続化
  P->>UI: 発注数または生産要請数を入力
  UI->>API: 意思決定を確定
  API->>DB: 役割別入力を保存
  API->>DB: 全 4 役割の完了を確認
  alt 全役割が完了
    API->>Core: 現在状態と意思決定で次週を計算
    Core-->>API: 在庫・受注残・遅延・費用
    API->>DB: 原子的かつ一度だけ週を確定
    API-->>UI: 次週状態を役割別に投影
  else 未完了
    API-->>UI: 他役割の入力待ち
  end
```

<!-- Text fallback: 参加者の意思決定を API が保存し、全役割が揃った場合だけ計算コアを呼び、次週状態を原子的に保存して役割別 UI へ返す。 -->

## Sources

- `gulpfile.js`
- `ops/scripts/`
- `docs/requirements/beer-game/requirements_definition.md`

## Assumptions & Open Questions

- 図のゲーム API、計算コア、永続化、UI は要件から導いた候補境界であり、現時点では未実装です。
