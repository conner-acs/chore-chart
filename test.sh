#!/usr/bin/env bash
# End-to-end smoke test for the deployed chore-chart API.
# Exercises all five Lambda routes: create -> list -> get -> update -> delete.
set -euo pipefail

# Strip any trailing slash so "$API/todos" never doubles up.
API="${API:-https://smswvajzoj.execute-api.us-east-1.amazonaws.com}"
API="${API%/}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "Testing API: $API"

echo "[1] POST /todos (create)"
created=$(curl -s -X POST "$API/todos" -d '{"title":"Take out the trash"}')
echo "    $created"
id=$(echo "$created" | jq -r '.id')
[ -n "$id" ] && [ "$id" != "null" ] || fail "no id returned"
[ "$(echo "$created" | jq -r '.title')" = "Take out the trash" ] || fail "title mismatch"
[ "$(echo "$created" | jq -r '.done')" = "false" ] || fail "done should default to false"
pass "created id=$id"

echo "[2] GET /todos (list)"
list=$(curl -s "$API/todos")
echo "    count=$(echo "$list" | jq -r '.count')"
echo "$list" | jq -e --arg id "$id" '.items[] | select(.id == $id)' >/dev/null \
  || fail "created todo not in list"
pass "todo present in list"

echo "[3] GET /todos/$id (get one)"
got=$(curl -s "$API/todos/$id")
[ "$(echo "$got" | jq -r '.id')" = "$id" ] || fail "get returned wrong id"
pass "fetched single todo"

echo "[4] PUT /todos/$id (mark done)"
updated=$(curl -s -X PUT "$API/todos/$id" -d '{"done":true}')
[ "$(echo "$updated" | jq -r '.done')" = "true" ] || fail "done not set to true"
pass "todo marked done"

echo "[5] DELETE /todos/$id"
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/todos/$id")
[ "$code" = "204" ] || fail "expected 204, got $code"
pass "deleted (204)"

echo "[6] GET /todos/$id (verify gone)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/todos/$id")
[ "$code" = "404" ] || fail "expected 404 after delete, got $code"
pass "confirmed 404 after delete"

printf '\n\033[32mAll checks passed.\033[0m\n'
