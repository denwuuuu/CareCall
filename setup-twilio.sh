#!/bin/zsh
# Asks for your Twilio keys, checks them with Twilio, and saves them to config.env.
# The auth token is typed hidden and never printed.
set -u
cd "$(dirname "$0")"

echo "CareCall — connect Twilio"
echo "Find these on https://console.twilio.com (Account Info box on the home page)."
echo
read "SID?Account SID (starts with AC): "
SID="${SID// /}"
read -s "TOKEN?Auth Token (hidden as you type/paste): "
echo
TOKEN="${TOKEN// /}"
echo "Number to call FROM: a Twilio number you bought, or your own mobile number"
echo "if it's verified in Twilio (the one you signed up with is)."
read "FROM?Number (e.g. +15551234567): "
FROM="$(echo "$FROM" | tr -cd '0-9+')"
[[ "$FROM" != +* && ${#FROM} -eq 10 ]] && FROM="+1$FROM"
[[ "$FROM" != +* ]] && FROM="+$FROM"

if [[ "$SID" != AC* || ${#SID} -ne 34 ]]; then
  echo "✗ That Account SID doesn't look right (34 characters, starting with AC)."; exit 1
fi

echo "Checking with Twilio…"
ACCOUNT=$(curl -s -u "$SID:$TOKEN" "https://api.twilio.com/2010-04-01/Accounts/$SID.json")
if ! echo "$ACCOUNT" | grep -q "\"sid\": *\"$SID\""; then
  echo "✗ Twilio rejected the SID or token. Copy them again from the Console home page."; exit 1
fi
TYPE=$(echo "$ACCOUNT" | sed -n 's/.*"type": *"\([^"]*\)".*/\1/p')

API="https://api.twilio.com/2010-04-01/Accounts/$SID"
OWNED=$(curl -s -u "$SID:$TOKEN" -G "$API/IncomingPhoneNumbers.json" --data-urlencode "PhoneNumber=$FROM")
VERIFIED=$(curl -s -u "$SID:$TOKEN" -G "$API/OutgoingCallerIds.json" --data-urlencode "PhoneNumber=$FROM")
if echo "$OWNED" | grep -q "\"phone_number\": *\"$FROM\""; then
  KIND="your Twilio number"
elif echo "$VERIFIED" | grep -q "\"phone_number\": *\"$FROM\""; then
  KIND="your verified number (text alerts need a bought Twilio number)"
else
  echo "✗ $FROM is neither a Twilio number on this account nor a verified caller ID."
  echo "  Use the mobile number you signed up with, or verify one under"
  echo "  Phone Numbers → Manage → Verified Caller IDs, then run this again."; exit 1
fi

# Keep any other settings already in config.env.
touch config.env
grep -v -E '^(TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_FROM_NUMBER)=' config.env > config.env.tmp
{
  echo "TWILIO_ACCOUNT_SID=$SID"
  echo "TWILIO_AUTH_TOKEN=$TOKEN"
  echo "TWILIO_FROM_NUMBER=$FROM"
  cat config.env.tmp
} > config.env
rm -f config.env.tmp
chmod 600 config.env

echo "✓ Saved. Account type: ${TYPE:-unknown}, calling from $FROM ($KIND)."
if [[ "$TYPE" == "Trial" ]]; then
  echo "  Trial account: it can only call verified numbers, and each call asks to press a key first."
fi
echo "  Restart CareCall (Ctrl+C, then: node server.js). The badge will say \"Live calls\"."
