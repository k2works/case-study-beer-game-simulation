#!/usr/bin/env bash
# 静的解析の規則そのものの確認（fixture の期待件数）。
# 違反するコードとしないコードの fixture に対し、期待件数・期待のルールが報告されることを確かめる。
# ルールを緩める・fixture を消すと、このスクリプトが失敗する（開発戦略「静的解析とルール設定」）。
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "NG: $1" >&2; exit 1; }

# 1. WartRemover と scalac のオプション: 13 個の Wart + 捨てた値の警告（-Werror で昇格）= 14 件
out=$(sbt -batch rulesFixtureWarts/compile 2>&1 || true)
echo "$out" | grep -q "14 errors found" || fail "WartRemover の fixture は 14 件を報告するはず（ガイド §9.4）"
for wart in Var Null Throw OptionPartial IterableOps AsInstanceOf IsInstanceOf Return MutableDataStructures TripleQuestionMark DefaultArguments; do
  echo "$out" | grep -q "\[wartremover:$wart\]" || fail "Wart $wart が報告されていない"
done
echo "$out" | grep -q "discarded non-Unit value" || fail "捨てた値の警告（-Wnonunit-statement）が報告されていない"
# 違反の無い関数（pureOk・sumOk）の行は報告されない
echo "$out" | grep -E "^\[error\] -- Error" | grep -E "Sample.scala:(4[0-9]|5[0-9])" && fail "違反の無いコードが報告された" || true
echo "OK: WartRemover と scalac の fixture（14 件）"

# 2. Scalafix の DisableSyntax.regex: println 1・clock 2・threadSleep 1・unsafeRun 1 = 5 件
sf=$(sbt -batch "rulesFixtureScalafix/scalafix --check" 2>&1 || true)
count=$(echo "$sf" | grep -c "error: \[DisableSyntax\." || true)
[ "$count" = "5" ] || fail "Scalafix の fixture は 5 件を報告するはず（実際: ${count}）"
for id in println clock threadSleep unsafeRun; do
  echo "$sf" | grep -q "\[DisableSyntax.$id\]" || fail "DisableSyntax.$id が報告されていない"
done
echo "$sf" | grep -q "def ok" && fail "違反の無いコード（ok）が報告された" || true
echo "$sf" | grep -q "sayOk" && fail "IO.println 相当（FakeIO.println）が誤検出された" || true
echo "OK: Scalafix の fixture（5 件）"
