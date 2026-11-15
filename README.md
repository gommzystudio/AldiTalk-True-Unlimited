# ALDI TALK re-booking helper

Keeps your Inland data topped up automatically.

With **Tarif L** you get 25 GB per 4 weeks. Once fewer than 1 GB is left, the
customer portal offers a **free "1 GB nachbuchen"** button that you may press as
often as you like. This script logs in, watches the counter and presses that
button for you when it gets low.

> The portal only accepts the button **below 1 GB remaining** — above that it
> ignores the click. The script therefore defaults to that same threshold.

## Requirements

- Node.js 18+
- A Chrome/Chromium binary (auto-detected, or set `CHROME_PATH`)
- Optional: PM2 to keep it running

## Install

```bash
npm install
cp .env.example .env
chmod 600 .env
$EDITOR .env          # phone number + password
npm run build
```

### `.env`

```ini
ALDITALK_USERNAME=01771234567
ALDITALK_PASSWORD=your-password
```

> **Do not use `USERNAME=` here.** `USERNAME` is a real environment variable
> (your OS account name) and it wins over the `.env` file, so the login form
> silently receives the wrong value. Use `ALDITALK_USERNAME` /
> `ALDITALK_PASSWORD` — the script refuses to start if the username equals your
> OS account name.

### Optional settings

| Key                     | Default | Meaning                                        |
| ----------------------- | ------- | ---------------------------------------------- |
| `CHECK_INTERVAL_MINUTES`| `5`     | How often to poll the counter                  |
| `TOPUP_THRESHOLD_MB`    | `1024`  | Book when remaining drops to/below this value  |
| `HEADLESS`              | `true`  | Set to `false` to watch the browser work       |
| `CHROME_PATH`           | auto    | Chrome/Chromium binary                         |
| `PROFILE_DIR`           | `./.chrome-profile` | Persistent browser profile       |

## Run

```bash
npm start            # continuous loop
npm run once         # single check, then exit
npm run dry-run      # single check, reports what it would do, books nothing
```

Logs are timestamped and state plainly whether something was booked.

## Run under PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs alditalk-extender
pm2 restart alditalk-extender
pm2 stop alditalk-extender
```

To survive reboots: `pm2 save && pm2 startup` (the latter prints a command that
needs root).

## Android app

`android/` contains the same job as a self-contained app, for the case where the
phone is the one holding the SIM: the booking has to come from that SIM's own
mobile-data connection, not from the machine hosting a browser.

- Plain Android framework Java, no AndroidX and no third-party dependencies.
- `JobScheduler` runs a check every 2, 15, 30 or 60 minutes (`minSdk 26`,
  `targetSdk 34`). JobScheduler refuses periodic intervals below 15 minutes, so
  a shorter interval is a one-shot job that the service re-arms after each run
  (the chain alternates between two job ids so a running job is never replaced
  by itself). Expect a little slack: the system may start it a minute late.
- A `BOOT_COMPLETED` receiver restores the schedule after a reboot.
- Credentials are encrypted with an AES/GCM key in the Android keystore.
- The service refuses to run unless the active network is cellular, so a Wi-Fi or
  hotspot connection can never produce the booking.
- The work happens in an off-screen `WebView` driven by
  `app/src/main/assets/automation.js`.

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Open the app, enter the number and password, choose an interval and press
**Save & schedule**. **Allow background runs** asks Android to leave the app
alone; **Run now** forces one check.

The last result is shown in the app and posted as a notification, e.g.
`Booked: 720 MB -> 1,7 GB` or `Nothing to book - 1,5 GB remaining`.

A dead session cookie makes the portal serve an anonymous dashboard without ever
showing the login form (every API call then answers `404`, and the page lands on
`/portal/auth/erneut-versuchen/`). The app detects that, clears the cookie jar
once and reloads, which brings back the login form.

Logs: `adb logcat -s AldiTalkJob`.

## How it works

1. Opens the customer portal in Chrome with a persistent profile.
2. Dismisses the Usercentrics cookie dialog, which otherwise sits on top of the
   usage meter and silently swallows the click.
3. Signs in if the session has expired (logins are avoided while a session is
   alive).
4. Reads the Inland counter, e.g. `720 MB`.
5. If it is at or below the threshold, clicks the `1 GB` button and waits for
   `POST …/selfcare-dashboard/v1/offer/update` plus the counter to rise.

## Troubleshooting

**"Refusing to start: the username resolved to the OS account"**
Use `ALDITALK_USERNAME`, not `USERNAME`, in `.env`.

**"Login never reached the customer portal"**
Wrong password, or the account wants a one-time password (Einmalpasswort) sent
by post. Log in manually once in the same profile (set `HEADLESS=false`) so the
portal can remember the device, or finish the one-time step by hand.

**"The click produced no request"**
Usually means the counter is above 1 GB and the portal refuses the booking, or a
consent overlay reappeared. The script retries once and logs it.

**"The layout changed"**
Everything DOM-related lives in the `SEL` constants at the top of
`src/index.ts`. The meter is identified by its `Inland` footer, the button by
`one-button[slot="action"]`. The Android app mirrors this in
`android/app/src/main/assets/automation.js`.

**App: "Skipped: not on mobile data"**
The phone is on Wi-Fi. The booking only counts when it arrives over the SIM, so
turn Wi-Fi off (or let the phone drop it) and the next check will run.

## Note

Automating the customer portal is your own decision and may be restricted by
ALDI TALK's terms of service. This only presses a button you are entitled to
press, but the account is yours and so is the risk.
