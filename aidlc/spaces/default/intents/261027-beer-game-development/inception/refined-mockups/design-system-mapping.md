# Design System Mapping

## Direction

既存 application design system はありません。native HTML を優先し、実装技術に依存しない semantic token と小さな component set を正本にします。

## Tokens

| Token | Purpose | Initial value |
|---|---|---|
| `color.surface` | page 背景 | `#FFFFFF` |
| `color.text` | 主 text | `#17202A` |
| `color.muted` | 補助 text | `#566573` |
| `color.action` | primary action | `#005FCC` |
| `color.success` | 完了 | `#147A3D` |
| `color.warning` | 注意 | `#8A5A00` |
| `color.danger` | error | `#B42318` |
| `focus.ring` | keyboard focus | 3 px solid `#FFBF47` |
| `space.unit` | spacing scale | 4 px |
| `radius.control` | control corner | 4 px |

実装前に normal text 4.5:1、large text と UI component 3:1、focus indicator 3:1 を実測します。

## Component mapping

| UI need | Semantic base | Project component |
|---|---|---|
| Primary action | `<button>` | `Button` |
| Navigation | `<nav>` + `<a>` | `AppNav` |
| Form field | `<label>` + `<input>` | `Field` |
| Validation summary | linked list | `ErrorSummary` |
| Status | text + icon | `StatusBadge` |
| 12-step progress | `<ol>` | `WeekProgress` |
| Role overview | `<table>` or `<ul>` | `RoleStatusList` |
| Confirmation | native `<dialog>` when supported | `ConfirmDialog` |
| Expandable details | `<details>` / `<summary>` | `Disclosure` |
| Async notice | live region | `LiveNotice` |
| Time-series data | SVG + table | `TimeSeriesComparison` |

## Usage rules

- icon-only button は避け、必要な場合は visible tooltip と accessible name を付けます。
- destructive action は danger color だけでなく明確な動詞と確認文を使います。
- `StatusBadge` は icon、text、色を組み合わせます。
- layout component は DOM reading order と視覚順を一致させます。
- chart library を選ぶ場合も table alternative と keyboard 操作を必須とします。

## Responsive layout

| Width | Grid | Operation policy |
|---|---|---|
| 1280 px 以上 | 12 columns、最大 1440 px | 全操作 |
| 1024〜1279 px | 8 columns | 全操作 |
| 768〜1023 px | 4 columns | 閲覧中心、複雑操作は利用環境を案内 |
| 767 px 以下 | 1 column | 状態閲覧と再接続案内 |

## Sources

- `mockups.md`
- `interaction-spec.md`
- `requirements.md` NFR5、NFR6

## Assumptions & Open Questions

- framework 固有 component library の採用は Tech Stack と Architecture の決定後に mapping を更新します。

