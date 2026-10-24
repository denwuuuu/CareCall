#!/bin/zsh
# Asks for your free Groq API key, checks it, picks a chat model your account
# has, and saves both to config.env. The key is typed hidden and never printed.
set -u
cd "$(dirname "$0")"

echo "CareCall — turn on natural chat with Groq (free)"
echo "Create a key at https://console.groq.com/keys (it starts with gsk_)."
echo
read -s "KEY?Groq API key (hidden as you type/paste): "
echo
KEY="${KEY// /}"
if [[ "$KEY" != gsk_* ]]; then
  echo "✗ That doesn't look like a Groq API key (it starts with gsk_)."; exit 1
fi

echo "Checking with Groq…"
MODELS=$(curl -s -w "\n%{http_code}" https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY")
CODE="${MODELS##*$'\n'}"
if [[ "$CODE" != "200" ]]; then
  echo "✗ Groq rejected the key (HTTP $CODE). Copy it again from the Groq console."; exit 1
fi

# Best conversational model first.
MODEL=""
for m in llama-3.3-70b-versatile openai/gpt-oss-120b meta-llama/llama-4-maverick-17b-128e-instruct meta-llama/llama-4-scout-17b-16e-instruct openai/gpt-oss-20b llama-3.1-8b-instant; do
  if echo "$MODELS" | grep -q "\"id\": *\"$m\""; then MODEL="$m"; break; fi
done
if [[ -z "$MODEL" ]]; then
  echo "✗ None of the chat models CareCall knows are on your Groq account."; exit 1
fi

touch config.env
grep -v -E '^(GROQ_API_KEY|GROQ_MODEL|BRAIN)=' config.env > config.env.tmp
{
  echo "BRAIN=groq"
  echo "GROQ_API_KEY=$KEY"
  echo "GROQ_MODEL=$MODEL"
  cat config.env.tmp
} > config.env
rm -f config.env.tmp
chmod 600 config.env

echo "✓ Saved. Calls will chat using $MODEL on Groq's free tier."
echo "  Restart CareCall (Ctrl+C, then: node server.js)."
