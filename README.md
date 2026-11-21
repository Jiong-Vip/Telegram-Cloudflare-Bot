[English] | [简体中文](./README.zh-CN.md)

# Cloudflare Management Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/) [![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots) [![GitHub stars](https://img.shields.io/github/stars/Jiong-Vip/Telegram-Cloudflare-Bot?style=social)](https://github.com/Jiong-Vip/Telegram-Cloudflare-Bot)

A single-file Telegram bot that runs entirely on one Cloudflare Worker (`worker.js`). One administrator can check free-tier usage, manage zones and DNS records, inspect Workers and Pages, and open public URLs from Telegram buttons. Every bot route sits behind a secret path, and all other traffic is redirected away.

## Features

1. Usage dashboard: today's Workers requests, D1 rows read and written, and KV reads and writes (GraphQL Analytics). Each metric shows a progress bar against the free daily limit (UTC day), plus zone, Worker, and Pages counts.
2. Zones and DNS: paginated zone list, zone detail (name servers, plan, dates), paginated DNS records with inline buttons, record detail, proxy toggle (orange and grey cloud), and delete with confirmation.
3. Workers and Pages: paginated lists and detail cards (last modified, workers.dev URL, custom domains, routes, recent deployments).
4. Public URLs: `/urls` lists every workers.dev URL, Worker custom domain and route, Pages `*.pages.dev` URL, and Pages custom domain as URL buttons that open directly in the browser.
5. One-click setup: `/setup` registers the webhook, sets the command menu (`/start`, `/dashboard`, `/zones`, `/workers`, `/pages`, `/urls`, `/help`), sets the chat menu button, and sends a bind-success card to the admin in Telegram with quick action buttons.
6. Control panel: `/{C}/{UUID}` shows an HTML status page (bot identity, webhook match, command count, last webhook error, and whether each environment variable is set; values are never shown).
7. Security: every Telegram update is checked against `from.id === TG_ID`. Other senders get no reply and the attempt is logged. Webhook calls must also carry the secret token derived from `TG_TOKEN`.

## Environment variables

Seven variables are required. Store the secrets encrypted (Dashboard: Workers and Pages, your Worker, Settings, Variables and Secrets, or `wrangler secret put`).

| Name | Required | Secret | Description |
| --- | --- | --- | --- |
| `CF_USER` | Yes | No | Cloudflare account email. Used as `X-Auth-Email` with a Global API Key. With an API Token it may also hold the 32-character account ID. |
| `CF_API_KEY` | Yes | Yes | Global API Key (37 hex characters, sent as `X-Auth-Key`) or an API Token (sent as Bearer). API Tokens are recommended. |
| `TG_ID` | Yes | No | Numeric Telegram user ID of the only administrator. Get it from `@userinfobot`. The bind card is sent to this ID. |
| `TG_TOKEN` | Yes | Yes | Bot token from `@BotFather`. The webhook secret is derived from it. |
| `C` | Yes | No | Secure path segment, for example `secure` or a custom word. Letters and digits are recommended. No slashes. |
| `UUID` | Yes | Yes | Secret path credential, for example a UUIDv4. Generate one with `uuidgen` or `crypto.randomUUID()`. |
| `URL_302` | Optional | No | Redirect target for all unauthorized or unknown requests. Defaults to `https://www.google.com` if unset or invalid. |

Optional: `CF_ACCOUNT_ID`. If set, the account lookup is skipped.

Never commit these values to source control. If `UUID` or `TG_TOKEN` leaks, rotate them and run `/setup` again.

## Routes

The secure base is `/{C}/{UUID}`. Every other request, including `GET /`, random paths, and wrong `C` or `UUID` values, returns `302` to `URL_302` immediately.

| Method and path | Purpose |
| --- | --- |
| `GET /{C}/{UUID}` | Control panel (HTML status page) |
| `GET /{C}/{UUID}/setup` | One-click setup: webhook, commands, menu button, bind-success message to `TG_ID` |
| `POST /{C}/{UUID}/webhook` | Telegram webhook (requires the secret token header) |
| anything else | `302` redirect to `URL_302` |

Example: if `C=secure` and `UUID=3f2a...`, the setup URL is `https://<worker-host>/secure/3f2a.../setup`.

## Permissions

Use a scoped API Token (Dashboard: My Profile, API Tokens, Create Custom Token) and limit it to the account and zones you want to manage:

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Account Analytics: Read | Dashboard usage (GraphQL) |
| Account | Workers Scripts: Read | Workers list, subdomain status, deployments |
| Account | Cloudflare Pages: Read | Pages projects and deployments |
| Account | Workers Custom Domains: Read | Worker custom domains |
| Account | Account Settings: Read | Account lookup |
| Account | D1: Read, Workers KV Storage: Read | Usage metrics |
| Zone | Zone: Read | Zone list and details |
| Zone | Workers Routes: Read | Worker route discovery |
| Zone | DNS: Edit | DNS records, proxy toggle, delete (DNS Read is included) |

The bot can change and delete DNS records, so keep the token private.

Telegram needs only the bot token. Optionally, in BotFather run `/setjoingroups` and disable group access so the bot works only in private chats.

## Deployment

Prerequisites: Node.js 18 or later, Wrangler (`npm i -g wrangler`), and `npx wrangler login`.

1. Create a project folder and put `worker.js` in it.

2. Create `wrangler.toml`:

   ```toml
   name = "cf-tg-bot"
   main = "worker.js"
   compatibility_date = "2024-09-23"
   workers_dev = true
   ```

3. Generate the secret path credential:

   ```bash
   uuidgen          # or: node -e "console.log(crypto.randomUUID())"
   ```

4. Set the secrets. Each command prompts for the value:

   ```bash
   npx wrangler secret put CF_USER
   npx wrangler secret put CF_API_KEY
   npx wrangler secret put TG_ID
   npx wrangler secret put TG_TOKEN
   npx wrangler secret put UUID
   npx wrangler secret put C
   npx wrangler secret put URL_302
   ```

   You can also store `C` and `URL_302` as plain variables under `[vars]` in `wrangler.toml`. Keep `UUID` and `TG_TOKEN` as secrets.

5. Deploy:

   ```bash
   npx wrangler deploy
   ```

6. Run the one-click setup in a browser:

   `https://<worker-host>/<C>/<UUID>/setup`

   The page should show `✅ 部署配置完成` (HTTP 200). Telegram should also deliver a bind-success card to `TG_ID` with buttons for 📊 仪表盘, 🌐 域名管理, ⚡ Workers, 📄 Pages, and 🔗 公网地址.

7. Check the control panel at `https://<worker-host>/<C>/<UUID>`. Webhook status should show "已对齐" (aligned), and the command count should be 7.

8. In Telegram, open the bot and send `/start`. The bottom keyboard appears.

Run `/setup` again after any change to the Worker URL, `UUID`, `C`, or `TG_TOKEN`. It is safe to repeat. Each run sends another bind card, so repeat it only when needed.

## Setup details

`/setup` performs these steps in order:

* `setWebhook` points Telegram at `https://<host>/<C>/<UUID>/webhook`, with `allowed_updates` set to `message` and `callback_query`, the secret token derived from `TG_TOKEN`, and pending updates dropped.
* `setMyCommands` registers `/start`, `/dashboard`, `/zones`, `/workers`, `/pages`, `/urls`, and `/help`.
* `setChatMenuButton` sets the menu button to the command list.
* `sendMessage` sends a bind-success card to `TG_ID`, with the status of each step and quick buttons. If a step failed, the card says so, and the setup page returns HTTP 502 with the details.

The bottom reply keyboard (📊 仪表盘, 🌐 域名, ⚙️ Workers, 📄 Pages, 🔗 公网地址) appears after `/start` or `/help`.

## Usage

* `/dashboard`: usage report. Use the refresh button to update it.
* `/zones`: zone list. Open a zone, then "DNS 记录" to browse records. Open a record to toggle its proxy status or delete it.
* `/workers` and `/pages`: project lists. Open a project for details and URL buttons.
* `/urls`: all public addresses as tappable buttons.

## Architecture

* `fetch` checks the secure base first. Any mismatch returns a 302 with no body.
* Webhook updates are processed in `ctx.waitUntil`, so Telegram gets an immediate 200.
* Cloudflare REST calls go through `cfFetch`, which adds the auth headers and turns `success: false` into readable errors. GraphQL calls go through `gql`.
* Views return `{ text, markup, reply }`. Callback data is short and `|`-separated (for example `RC|zoneId|page|index`) to stay under Telegram's 64-byte limit.
* Record and project buttons use list indexes. Each callback re-reads the current page to resolve the index. If the list changed, the bot says so and asks you to reopen it.
* Output is HTML with escaped user data. Long messages are trimmed.

## Limitations

* Workers request and D1/KV counts come from GraphQL Analytics and can lag by a few minutes. Free limits reset at UTC 00:00.
* KV reads and writes are classified by action name, so the split is approximate.
* Deployment history depends on the endpoints your token can read. If one is unavailable, that section shows "—" and the rest of the card still loads.
* Route discovery reads up to 1,000 zones (20 pages of 50). Larger accounts may miss some routes.
* DNS editing is limited to viewing, proxy toggling, and deleting. Content and TTL cannot be changed.
* The bot does not change Worker code or trigger Pages builds.

## Troubleshooting

* Browser opens `URL_302` instead of the control panel: check that `C` and `UUID` match the URL exactly. Both are case-sensitive, and `C` must not contain slashes.
* Setup returns HTTP 502: read the JSON in the response. A `setWebhook` error usually means `TG_TOKEN` is wrong or the Worker URL is not public.
* No bind card in Telegram: send `/start` to the bot first, then run `/setup` again. Bots cannot message a user who has never started them. Also confirm `TG_ID` is numeric.
* Dashboard shows N/A: the token is missing Account Analytics: Read, or the account has no activity for that product yet.
* Control panel shows "未对齐" (not aligned): run `/setup` again.
* "Cloudflare API: ..." errors: check the token scopes and that the zone is covered by the token's resource list.
* Buttons say the list changed: reopen the list command.

## Security notes

* Only `TG_ID` can use the bot. Other senders are ignored and logged.
* The secure path and Telegram secret token both protect the webhook, so a guessed URL alone is not enough.
* The control panel shows only whether each variable is set, never its value.
* `/setup` and the control panel are reachable by anyone who knows the secure path. Treat that path like a password.
* Rotate `UUID`, `CF_API_KEY`, and `TG_TOKEN` if any of them is exposed, then run `/setup` again.

## License

This project is released under the [MIT License](./LICENSE). Copyright (c) 2026 Jiong-Vip.

You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this software, provided the copyright notice and permission notice are included in all copies or substantial portions. The software is provided "AS IS", without warranty of any kind.
