-- Up Migration
-- U2（週次ルールの完成）: 費用の列を 64 ビット整数にする（BR8.2）。
-- 上限の設定（BR8.1）では、1 役割の累積費用が 32 ビット整数（約 2.1 × 10 の 9 乗）を超える。
-- 既存の値は変わらない。アプリケーションは、pg が文字列で返す 64 ビット整数を安全な整数の範囲で数値にする。

alter table week_records alter column weekly_cost type bigint;
alter table week_records alter column cumulative_cost type bigint;

-- Down Migration
-- 32 ビット整数に収まらない値が入っている場合、この移行の取り消しは失敗する（値を丸めない）。

alter table week_records alter column cumulative_cost type integer;
alter table week_records alter column weekly_cost type integer;
