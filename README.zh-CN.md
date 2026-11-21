[English](./README.md) | [简体中文]

# Cloudflare 管理 Telegram 机器人

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/) [![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)

一个单文件 Telegram 机器人，完全运行在一个 Cloudflare Worker（`worker.js`）上。唯一的管理员可以通过机器人查看免费额度用量、管理域名与 DNS 记录、查看 Workers 与 Pages，并通过按钮直接打开公网地址。所有机器人路由都位于一个保密路径之下，其他流量一律重定向。

## 功能特性

1. 用量仪表盘：统计今日 Workers 请求数、D1 读写行数、KV 读写次数（数据来自 GraphQL Analytics）。每项指标以进度条显示其相对免费每日额度（UTC 日）的占比，并附带域名、Workers、Pages 的数量统计。
2. 域名与 DNS：分页显示托管域名列表；域名详情包括 NS 服务器、套餐与时间信息；DNS 记录分页显示，支持记录详情、代理状态切换（橙云 / 灰云）以及带确认的删除操作。
3. Workers 与 Pages：分页列表与详情卡片（最后修改时间、workers.dev 地址、自定义域名、路由、最近部署记录）。
4. 公网地址：`/urls` 汇总所有 workers.dev 地址、Worker 自定义域名与路由、Pages `*.pages.dev` 地址以及 Pages 自定义域名，并以 URL 按钮形式提供，点击即可在浏览器中打开。
5. 一键配置：`/setup` 会注册 Webhook、设置命令菜单（`/start`、`/dashboard`、`/zones`、`/workers`、`/pages`、`/urls`、`/help`）、切换聊天菜单按钮，并向管理员发送绑定成功卡片，附带快捷操作按钮。
6. 控制面板：访问 `/{C}/{UUID}` 可查看 HTML 状态页，内容包括机器人身份、Webhook 是否对齐、命令数量、最近一次 Webhook 错误，以及每个环境变量是否已设置（页面从不显示变量的具体值）。
7. 安全机制：每条 Telegram 更新都会校验 `from.id === TG_ID`。其他发送者不会得到任何回复，尝试行为会被记录。Webhook 请求还必须携带由 `TG_TOKEN` 派生的 secret token 请求头。

## 环境变量

必需的变量共 7 个。敏感信息请以加密 Secret 形式保存（控制台：Workers 与 Pages → 你的 Worker → Settings → Variables and Secrets，或使用 `wrangler secret put`）。

| 名称 | 是否必需 | 是否为 Secret | 说明 |
| --- | --- | --- | --- |
| `CF_USER` | 是 | 否 | Cloudflare 账户邮箱。使用 Global API Key 时作为 `X-Auth-Email`。使用 API Token 时，也可以填写 32 位账户 ID。 |
| `CF_API_KEY` | 是 | 是 | Global API Key（37 位十六进制字符，以 `X-Auth-Key` 发送）或 API Token（以 Bearer 方式发送）。推荐使用 API Token。 |
| `TG_ID` | 是 | 否 | 唯一管理员的数字型 Telegram 用户 ID。可通过 `@userinfobot` 获取。绑定卡片将发送到此 ID。 |
| `TG_TOKEN` | 是 | 是 | 通过 `@BotFather` 获取的机器人 Token。Webhook 的 secret token 由它派生。 |
| `C` | 是 | 否 | 保密路径的第一段，例如 `secure` 或自定义单词。建议使用字母和数字，不能包含斜杠。 |
| `UUID` | 是 | 是 | 保密路径的第二段凭证，例如 UUIDv4。可用 `uuidgen` 或 `crypto.randomUUID()` 生成。 |
| `URL_302` | 可选 | 否 | 所有未授权或未知请求的重定向目标。未设置或无效时默认为 `https://www.google.com`。 |

可选变量：`CF_ACCOUNT_ID`。设置后将跳过账户查询。

请勿将这些值提交到源代码仓库。如果 `UUID` 或 `TG_TOKEN` 泄露，请轮换后重新执行 `/setup`。

## 路由

保密基础路径为 `/{C}/{UUID}`。其他所有请求（包括 `GET /`、随机路径，以及 `C` 或 `UUID` 错误的请求）都会立即返回 `302`，跳转到 `URL_302`。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /{C}/{UUID}` | 控制面板（HTML 状态页） |
| `GET /{C}/{UUID}/setup` | 一键配置：Webhook、命令菜单、菜单按钮，并向 `TG_ID` 发送绑定成功消息 |
| `POST /{C}/{UUID}/webhook` | Telegram Webhook（要求携带 secret token 请求头） |
| 其他任意路径 | `302` 重定向到 `URL_302` |

示例：若 `C=secure`、`UUID=3f2a...`，则配置地址为 `https://<worker-host>/secure/3f2a.../setup`。

## 权限

建议使用限定范围的 API Token（控制台：My Profile → API Tokens → Create Custom Token），并将其限制在你要管理的账户与域名之内：

| 范围 | 权限 | 用途 |
| --- | --- | --- |
| Account | Account Analytics: Read | 仪表盘用量（GraphQL） |
| Account | Workers Scripts: Read | Workers 列表、子域名状态、部署记录 |
| Account | Cloudflare Pages: Read | Pages 项目与部署记录 |
| Account | Workers Custom Domains: Read | Worker 自定义域名 |
| Account | Account Settings: Read | 账户查询 |
| Account | D1: Read、Workers KV Storage: Read | 用量指标 |
| Zone | Zone: Read | 域名列表与详情 |
| Zone | Workers Routes: Read | Worker 路由发现 |
| Zone | DNS: Edit | DNS 记录、代理切换、删除（已包含 DNS Read） |

机器人可以修改和删除 DNS 记录，请妥善保管该 Token。

Telegram 只需要机器人 Token。可选操作：在 BotFather 中执行 `/setjoingroups` 并禁止群组加入，使机器人仅可用于私聊。

## 部署

前置条件：Node.js 18 或更高版本、Wrangler（`npm i -g wrangler`），并执行 `npx wrangler login`。

1. 创建项目目录，并将 `worker.js` 放入其中。

2. 创建 `wrangler.toml`：

   ```toml
   name = "cf-tg-bot"
   main = "worker.js"
   compatibility_date = "2024-09-23"
   workers_dev = true
   ```

3. 生成保密路径凭证：

   ```bash
   uuidgen          # 或：node -e "console.log(crypto.randomUUID())"
   ```

4. 设置 Secret。每条命令都会提示输入对应的值：

   ```bash
   npx wrangler secret put CF_USER
   npx wrangler secret put CF_API_KEY
   npx wrangler secret put TG_ID
   npx wrangler secret put TG_TOKEN
   npx wrangler secret put UUID
   npx wrangler secret put C
   npx wrangler secret put URL_302
   ```

   也可以把 `C` 和 `URL_302` 作为普通变量写在 `wrangler.toml` 的 `[vars]` 中。`UUID` 与 `TG_TOKEN` 请保持为 Secret。

5. 部署：

   ```bash
   npx wrangler deploy
   ```

6. 在浏览器中执行一键配置：

   `https://<worker-host>/<C>/<UUID>/setup`

   页面应显示 `✅ 部署配置完成`（HTTP 200）。Telegram 也会向 `TG_ID` 推送绑定成功卡片，附带 📊 仪表盘、🌐 域名管理、⚡ Workers、📄 Pages、🔗 公网地址 等按钮。

7. 访问控制面板 `https://<worker-host>/<C>/<UUID>` 检查状态。Webhook 状态应显示“已对齐”，命令数量应为 7。

8. 在 Telegram 中打开机器人并发送 `/start`，底部快捷键盘随即出现。

修改 Worker 地址、`UUID`、`C` 或 `TG_TOKEN` 后，请重新执行 `/setup`。重复执行是安全的，但每次都会再发送一条绑定卡片，因此仅在需要时执行。

## 配置细节

`/setup` 按以下顺序执行：

* `setWebhook`：将 Telegram 指向 `https://<host>/<C>/<UUID>/webhook`，`allowed_updates` 设为 `message` 与 `callback_query`，secret token 由 `TG_TOKEN` 派生，并丢弃待处理的更新。
* `setMyCommands`：注册 `/start`、`/dashboard`、`/zones`、`/workers`、`/pages`、`/urls` 与 `/help`。
* `setChatMenuButton`：将菜单按钮设置为命令列表。
* `sendMessage`：向 `TG_ID` 发送绑定成功卡片，列出每一步的状态并附带快捷按钮。若某一步失败，卡片会明确标出，配置页面将返回 HTTP 502 及详细信息。

发送 `/start` 或 `/help` 后，底部会出现快捷键盘（📊 仪表盘、🌐 域名、⚙️ Workers、📄 Pages、🔗 公网地址）。

## 使用方法

* `/dashboard`：用量报告，可使用刷新按钮更新。
* `/zones`：域名列表。打开某个域名后点击“DNS 记录”浏览记录；打开某条记录可切换代理状态或删除。
* `/workers` 与 `/pages`：项目列表。打开某个项目可查看详情与 URL 按钮。
* `/urls`：以可点击按钮的形式列出所有公网地址。

## 架构

* `fetch` 首先校验保密基础路径。任何不匹配的请求都会返回无响应体的 302。
* Webhook 更新在 `ctx.waitUntil` 中处理，Telegram 可立即收到 200 响应。
* Cloudflare REST 调用经由 `cfFetch`，它会添加认证头，并将 `success: false` 转换为可读错误。GraphQL 调用经由 `gql`。
* 视图返回 `{ text, markup, reply }`。回调数据采用简短的 `|` 分隔格式（例如 `RC|zoneId|page|index`），以符合 Telegram 的 64 字节限制。
* 记录与项目按钮使用列表索引。每次回调都会重新读取当前页面来解析索引。若列表已变化，机器人会提示并要求重新打开列表。
* 输出为转义后的 HTML。过长的消息会被截断。

## 限制说明

* Workers 请求数及 D1/KV 计数来自 GraphQL Analytics，可能滞后数分钟。免费额度于 UTC 00:00 重置。
* KV 读写依据操作类型名称划分，因此拆分结果为近似值。
* 部署历史取决于你的 Token 可读取的接口。若某个接口不可用，对应区域显示“—”，其余卡片仍正常加载。
* 路由发现最多读取 1,000 个域名（20 页，每页 50 条）。规模更大的账户可能会漏掉部分路由。
* DNS 编辑仅限查看、切换代理与删除，无法修改内容或 TTL。
* 机器人不会修改 Worker 代码，也不会触发 Pages 构建。

## 故障排查

* 浏览器跳转到 `URL_302` 而非控制面板：请确认 `C` 与 `UUID` 与 URL 完全一致。两者均区分大小写，且 `C` 不能包含斜杠。
* 配置返回 HTTP 502：请阅读响应中的 JSON。`setWebhook` 报错通常意味着 `TG_TOKEN` 错误或 Worker 地址不可公开访问。
* Telegram 未收到绑定卡片：请先向机器人发送 `/start`，再重新执行 `/setup`。机器人无法向从未启动它的用户发送消息。同时确认 `TG_ID` 为数字型。
* 仪表盘显示 N/A：Token 缺少 Account Analytics: Read 权限，或该产品在账户中暂无活动数据。
* 控制面板显示“未对齐”：请重新执行 `/setup`。
* 出现 “Cloudflare API: ...” 错误：请检查 Token 的权限范围，并确认该域名包含在 Token 的资源列表中。
* 按钮提示列表已变化：请重新打开对应的列表命令。

## 安全说明

* 只有 `TG_ID` 可以使用机器人。其他发送者会被忽略并记录。
* 保密路径与 Telegram secret token 共同保护 Webhook，仅知道 URL 并不足以访问。
* 控制面板只显示变量是否已设置，从不显示变量的值。
* 任何知道保密路径的人都可以访问 `/setup` 与控制面板，请像对待密码一样对待该路径。
* 若 `UUID`、`CF_API_KEY` 或 `TG_TOKEN` 任一泄露，请立即轮换并重新执行 `/setup`。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源，版权所有 (c) 2026 Jiong-Vip。

您可以免费使用、复制、修改、合并、发布、分发、再授权和销售本软件的副本，但须在所有副本或实质性部分中保留版权声明和许可声明。本软件按“原样”提供，不附带任何形式的明示或暗示担保。

仓库地址：[Jiong-Vip/Telegram-Cloudflare-Bot](https://github.com/Jiong-Vip/Telegram-Cloudflare-Bot)
