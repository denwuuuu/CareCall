<p align="center"><img src="logo/carecall-logo.svg" alt="CareCall" width="520"></p>

# CareCall

Automatic check-in calls for older relatives at times you choose. If they don't
pick up, the call is flagged, and the app calls again on your schedule.

## Start it

```bash
git clone https://github.com/denwuuuu/CareCall.git
cd CareCall
npm install
node server.js
```

Then open http://127.0.0.1:8790 (Node 20+).

Without Twilio keys it runs in **simulation**: calls "ring" on the page and you
play the other person (pick up, let it ring, voicemail, busy). Nobody is phoned.

## How it works

- **People**: name, phone, and *their* time zone (calls go out at their local time).
- **Schedules**: as many call times a day as you like, repeated on the weekdays
  you pick (every day / weekdays / weekends / any mix). A person can have several
  schedules, e.g. 9 AM + 7 PM on weekdays and 11 AM on weekends.
- **When they pick up**: a check-in chat. A natural voice (pick it in Settings)
  waits for their "Hello?", then says your lines one at a time and listens for an
  answer after each. Their answers show up in Call history. Or "connect them to
  me" rings your phone and joins you.
- **If they go quiet**: after 10s "Take your time, I'm still here", then 5s
  more. Still nothing: it rings your phone (Settings → Your phone number) and
  connects them to you.
- **Chat naturally (AI)**: with a free Groq key (`./setup-groq.sh`) or an
  Anthropic key (`./setup-claude.sh`), calls become a real conversation: small talk and follow-ups that cover your
  topics. Anything worrying is pushed to you right away, a possible emergency
  rings you, and every call ends with a two-sentence summary sent to your phone.
  Without a key, or if the AI doesn't answer within 9s, it reads your lines instead.
  Groq's free tier is limited by requests per day (a call uses about 10–15).
  `BRAIN=groq|claude` in config.env picks one; `GROQ_MODEL` / `CLAUDE_MODEL` change the model.
- **Questions**: pick ready-made ones (medicine, meals, nap, sleep, water, a walk,
  pain, appointments, anything they need) or write your own.
- **Missed calls**: no answer, busy, voicemail, or picking up and saying nothing
  all count as missed. The call is flagged, and if retries are on it calls again
  after N minutes, up to N calls. From the alert you can change the next call
  time, call now, stop retrying, or mark them OK. Answering any retry clears the alert.
- **Alerts**: on the page, optional desktop notifications, and (live mode) a text
  to your phone.

## Real calls (Twilio)

1. Make a Twilio account, buy a phone number (about $1.15/month; US calls are
   about 1.4¢/minute).
2. `cp config.example.env config.env` and fill in the SID, auth token and number.
3. Restart. The badge turns green: **Live calls**.

The app must stay running (Mac awake) for calls to go out. A call time missed by
more than 15 minutes because the app was off is skipped, not made late.

Listening to answers needs Twilio to reach this app during the call. CareCall
starts a free Cloudflare tunnel for that by itself (`brew install cloudflared`);
the terminal prints "Call link ready". Only Twilio's signed requests get through
it; the rest of the app stays private to your Mac.

**Rings you if they go quiet** only works when your phone number in Settings is
different from the number CareCall calls from. Calling from your own verified
mobile? Buy a Twilio number (~$1.15/month) and rerun `./setup-twilio.sh` with it.

**iPhone call screening**: if their iPhone has "Screen Unknown Callers" on, it
answers for them. Save CareCall's number in their Contacts so it rings normally.

Only call people who have agreed to receive these automated calls.

Data lives in `data.json` next to the server.

## Team

- Dennis Wu ([@denwuuuu](https://github.com/denwuuuu))
- Harris Chan ([@harrisjchan](https://github.com/harrisjchan))

Built with help from [Claude Code](https://claude.com/claude-code).
