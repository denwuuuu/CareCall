#!/bin/zsh
# Asks for your Anthropic API key, checks it, and saves it to config.env so
# calls can chat naturally. The key is typed hidden and never printed.
set -u
cd "$(dirname "$0")"

echo "CareCall — turn on natural chat (Claude)"
echo "Create a key at https://console.anthropic.com/settings/keys (it starts with sk-ant-)."
echo
read -s "KEY?Anthropic API key (hidden as you type/paste): "
echo
KEY="${KEY// /}"
if [[ "$KEY" != sk-ant-* ]]; then
  echo "✗ That doesn't look like an Anthropic API key (it starts with sk-ant-)."; exit 1
fi

echo "Checking with Anthropic…"
CODE=$(curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/v1/models \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01")
if [[ "$CODE" != "200" ]]; then
  echo "✗ Anthropic rejected the key (HTTP $CODE). Copy it again, or check billing in the Console."; exit 1
fi

touch config.env
grep -v -E '^ANTHROPIC_API_KEY=' config.env > config.env.tmp
{ echo "ANTHROPIC_API_KEY=$KEY"; cat config.env.tmp; } > config.env
rm -f config.env.tmp
chmod 600 config.env

echo "✓ Saved. Restart CareCall (Ctrl+C, then: node server.js) and calls will chat naturally."
