#!/usr/bin/env bash
# 秘密情報の検査（SR13。NF-S13）。追跡されているファイルに、鍵・トークンの形の文字列が無いことを確かめる。
# 検査の確かめ: 秘密の形の文字列を含む入力で失敗し、無害な入力で通ることを、自己テストで先に確認する。
set -euo pipefail
cd "$(dirname "$0")/.."

pattern='(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,})'

scan() { grep -E -n "$pattern" || true; }

# 自己テスト（検査が空振りしないこと）
[ -n "$(printf 'k=AKIA%s\n' ABCDEFGHIJKLMNOP | scan)" ] || { echo "NG: 検査が秘密の形を検出しない" >&2; exit 1; }
[ -z "$(printf 'name=beer-game\n' | scan)" ] || { echo "NG: 検査が無害な入力を誤検出する" >&2; exit 1; }

found="$(git ls-files -z . | grep -zv 'scripts/check-secrets.sh' | xargs -0 grep -E -n "$pattern" 2>/dev/null || true)"
if [ -n "$found" ]; then
  echo "NG: 秘密情報の形の文字列がある" >&2
  echo "$found" | cut -d: -f1,2 >&2
  exit 1
fi
echo "OK: 秘密情報の形の文字列なし"
