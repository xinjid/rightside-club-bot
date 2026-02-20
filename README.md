# RightSide Admin Bot

Electron desktop app for Telegram admin bot + SmartShell GraphQL.

## Run

```bash
npm install
npm start
```

## Build (Windows NSIS)

```bash
npm run dist:win
```

Publish is disabled (`--publish never`), no `GH_TOKEN` required.

## Fixed SmartShell constants

- `BILLING_GRAPHQL_URL = https://billing.smartshell.gg/api/graphql`
- `SMARTSHELL_COMPANY_ID = 2128`

Login/password and Telegram bot token are entered in Settings (`⚙`) and stored locally.

## Local storage

Files in Electron `userData`:

- `settings.json` (app settings)
- `rightside.db` (SQLite data: users/invites/discount_jobs)
- `logs/app.log` (application logs)

## Main commands

Telegram and UI Bot Console use one command layer:

- `/ping`
- `/who <phone>`
- `/discount_set <phone> <value> <duration>`
- `/discount_remove <phone>`
- `/discount_list`
- `/discount_cancel <jobId>`

Also available:

- `/invite <admin|moderator>`
- `/setrole <telegram_user_id> <admin|moderator>`
- `/remove_user <telegram_user_id>`

## Discount scheduler

Every 60 seconds:

- `scheduled` + `starts_at <= now` -> apply discount
- `active` + `ends_at <= now` -> revert discount (previous value or 0) and finish job

Active and scheduled jobs are shown in the right panel **Активные скидки**.

## Quick verification

1. `npm start`
2. Open `⚙`, set Telegram token + SmartShell login/password, save.
3. Click `Test SmartShell`.
4. In Bot Console run `discount_set` on a test phone.
5. Verify job appears in right panel **Активные скидки**.
6. Run `discount_list` and `discount_cancel`, verify panel updates.
7. In Telegram run `/ping`, `/who`, `/discount_set`, `/discount_list`.
