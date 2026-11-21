/**
 * Cloudflare Management Telegram Bot - single-file Cloudflare Worker (worker.js).
 *
 * Features: usage dashboard (GraphQL Analytics), zones and DNS management
 * (pagination, record detail, proxy toggle, delete), Workers and Pages inspection,
 * public URL buttons, automatic command/menu setup and webhook setup.
 *
 * Bindings (secrets or vars):
 *   CF_USER, CF_API_KEY  Cloudflare credentials
 *   TG_ID, TG_TOKEN      Telegram admin user ID and bot token
 *   C, UUID              Secure path prefix: bot routes live under /{C}/{UUID}
 *   URL_302              Redirect target for all other requests (default https://www.google.com)
 * Optional: CF_ACCOUNT_ID (skips account lookup).
 *
 * Routes:
 *   GET  /{C}/{UUID}          status dashboard (HTML)
 *   GET  /{C}/{UUID}/setup    webhook, commands, menu button, bind-success message to TG_ID
 *   POST /{C}/{UUID}/webhook  Telegram updates
 *   anything else             302 redirect to URL_302
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 8;
const MAX_URL_BUTTONS = 40;
const REQUIRED_ENV = ["CF_USER", "CF_API_KEY", "TG_ID", "TG_TOKEN", "C", "UUID"];
const ALL_ENV = [...REQUIRED_ENV, "URL_302"];
const FALLBACK_302 = "https://www.google.com";

const FREE_LIMITS = {
  workersRequests: 100000, // per UTC day
  d1RowsRead: 5000000, // per UTC day
  d1RowsWritten: 100000, // per UTC day
  kvReads: 100000, // per UTC day
  kvWrites: 1000, // per UTC day
};

const BOT_COMMANDS = [
  { command: "start", description: "开始 · 主菜单" },
  { command: "dashboard", description: "监控仪表盘播报" },
  { command: "zones", description: "托管域名与 DNS 记录" },
  { command: "workers", description: "Workers 列表与详情" },
  { command: "pages", description: "Pages 列表与详情" },
  { command: "urls", description: "全部项目公网地址" },
  { command: "help", description: "使用帮助" },
];

const REPLY_KEYBOARD = {
  keyboard: [
    [{ text: "📊 仪表盘" }, { text: "🌐 域名" }],
    [{ text: "⚙️ Workers" }, { text: "📄 Pages" }],
    [{ text: "🔗 公网地址" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const TEXT_ROUTES = {
  "/start": "start",
  "/help": "help",
  "/dashboard": "dashboard",
  "/zones": "zones",
  "/workers": "workers",
  "/pages": "pages",
  "/urls": "urls",
  "📊 仪表盘": "dashboard",
  "🌐 域名": "zones",
  "⚙️ Workers": "workers",
  "📄 Pages": "pages",
  "🔗 公网地址": "urls",
};

let accountIdCache = null;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      const base = securePath(env);
      if (!base) return redirectTo(env);

      const path = stripTrailingSlash(new URL(request.url).pathname);
      const method = request.method.toUpperCase();

      if (method === "GET" && path === base) return await handleStatusPage(request, env);
      if (method === "GET" && path === `${base}/setup`) return await handleSetup(request, env);
      if (method === "POST" && path === `${base}/webhook`) return await handleWebhook(request, env, ctx);
      return redirectTo(env);
    } catch (err) {
      console.error("fetch error:", err);
      return redirectTo(env);
    }
  },
};

/** Normalized secure path "/{C}/{UUID}", or null when C or UUID is unset or invalid. */
function securePath(env) {
  const c = String(env.C ?? "").trim().replace(/^\/+|\/+$/g, "");
  const u = String(env.UUID ?? "").trim();
  if (!c || !u || /[\/?#\\]/.test(c) || /[\/?#\\]/.test(u)) return null;
  return `/${c}/${u}`;
}

function stripTrailingSlash(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Any request that is not an authorized route is redirected to URL_302. */
function redirectTo(env) {
  let target = FALLBACK_302;
  try {
    const u = new URL(String(env.URL_302 ?? "").trim());
    if (u.protocol === "https:" || u.protocol === "http:") target = u.toString();
  } catch {
    // Invalid URL_302: keep the fallback.
  }
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Webhook and setup
// ---------------------------------------------------------------------------

async function webhookSecret(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleWebhook(request, env, ctx) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) return redirectTo(env);

  const expected = await webhookSecret(env.TG_TOKEN);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) {
    return redirectTo(env);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return redirectTo(env);
  }

  // Acknowledge Telegram quickly; process in the background.
  ctx.waitUntil(
    dispatch(update, env).catch((err) => console.error("dispatch error:", err))
  );
  return new Response("ok");
}

/** One-click setup: webhook, command menu, menu button, then a bind-success card to TG_ID. */
async function handleSetup(request, env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) {
    return htmlResponse(`缺少环境变量: ${missing.join(", ")}`, 500);
  }

  const base = securePath(env);
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}${base}/webhook`;
  const secret = await webhookSecret(env.TG_TOKEN);

  const results = {
    setWebhook: await tgCall(env, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
    setMyCommands: await tgCall(env, "setMyCommands", { commands: BOT_COMMANDS }),
    setChatMenuButton: await tgCall(env, "setChatMenuButton", {
      menu_button: { type: "commands" },
    }),
  };

  const allOk = Object.values(results).every((r) => r.ok);

  // Notify the admin in Telegram that binding finished (also reports partial failures).
  const notice = await tgCall(env, "sendMessage", {
    chat_id: String(env.TG_ID).trim(),
    text: bindCard(origin, base, results),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: bindKeyboard(origin, base),
  });

  const summary = { webhookUrl, allOk, bindNotificationSent: !!notice.ok, results: { ...results, notice } };
  return htmlResponse(
    `${allOk ? "✅ 部署配置完成" : "⚠️ 部分配置失败"}\n\n${JSON.stringify(summary, null, 2)}`,
    allOk ? 200 : 502
  );
}

function bindCard(origin, base, results) {
  const step = (label, r) => `${r.ok ? "🟢" : "🔴"} ${label}${r.ok ? "" : ` · ${esc(r.description || "failed")}`}`;
  const lines = [
    step("Webhook 已绑定", results.setWebhook),
    step("命令菜单已同步", results.setMyCommands),
    step("菜单按钮已切换", results.setChatMenuButton),
  ];
  const allOk = Object.values(results).every((r) => r.ok);
  const body = [
    allOk ? "<b>状态</b>  ✅ 绑定成功 · 已初始化 · 就绪" : "<b>状态</b>  ⚠️ 绑定完成，但存在失败项",
    `<b>时间</b>  ${fmtDate(new Date().toISOString())}`,
    `<b>端点</b>  <code>${esc(origin + base)}</code>`,
    "",
    ...lines,
    "",
    "发送 /dashboard 查看用量，或点击下方快捷按钮开始管理。",
  ].join("\n");
  return card("🛰 Cloudflare 管理机器人 · 绑定成功", body);
}

function bindKeyboard(origin, base) {
  return kb([
    [btn("📊 仪表盘", "DB")],
    [btn("🌐 域名管理", "ZL|1"), btn("⚡ Workers", "WL|w|1")],
    [btn("📄 Pages", "WL|p|1"), btn("🔗 公网地址", "UR")],
    [urlBtn("🖥 控制面板", origin + base)],
  ]);
}

/** Management/status dashboard at /{C}/{UUID}. Shows presence of env vars, never their values. */
async function handleStatusPage(request, env) {
  const base = securePath(env);
  const origin = new URL(request.url).origin;
  const expectedHook = `${origin}${base}/webhook`;

  const [me, hook, cmds] = await Promise.all([
    tgCall(env, "getMe", {}),
    tgCall(env, "getWebhookInfo", {}),
    tgCall(env, "getMyCommands", {}),
  ]);
  const bot = me.result || {};
  const info = hook.result || {};
  const hookOk = info.url === expectedHook;
  const commandCount = Array.isArray(cmds.result) ? cmds.result.length : 0;
  const cmdOk = commandCount === BOT_COMMANDS.length;

  const row = (label, value, ok) =>
    `<tr><th>${esc(label)}</th><td class="${ok === undefined ? "" : ok ? "ok" : "bad"}">${value}</td></tr>`;
  const envRows = ALL_ENV.map((k) => row(k, env[k] ? "已设置" : "未设置", !!env[k])).join("");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>CF-TG Control</title>
<style>
  body{margin:0;background:#0b0f0c;color:#7CFC9A;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px}
  h1{font-size:18px;color:#B6FFCF;margin:0 0 4px}
  .sub{color:#4a7a5a;margin-bottom:20px}
  table{border-collapse:collapse;width:100%;max-width:820px;margin-bottom:20px}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #1d3326;vertical-align:top;word-break:break-all}
  th{width:200px;color:#5fb37f;font-weight:normal}
  .ok{color:#7CFC9A}.bad{color:#ff6b6b}
  .btns a{display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border:1px solid #2fbf6a;color:#B6FFCF;text-decoration:none;border-radius:4px}
  .btns a:hover{background:#15301f}
  code{color:#E6FFE6}
  footer{color:#3b5f48;margin-top:24px;font-size:12px}
</style></head>
<body>
<h1>&gt; CF-TG Control Panel</h1>
<div class="sub">Cloudflare 管理机器人 · 状态面板</div>
<table>
${row("Bot", bot.username ? `@${esc(bot.username)} (${esc(bot.first_name)})` : "无法获取 (检查 TG_TOKEN)", !!bot.username)}
${row("Webhook 期望地址", `<code>${esc(expectedHook)}</code>`)}
${row("Webhook 当前地址", info.url ? `<code>${esc(info.url)}</code>` : "未设置", hookOk)}
${row("Webhook 状态", hookOk ? "已对齐" : "未对齐，请执行一键配置", hookOk)}
${row("待处理更新", esc(info.pending_update_count ?? "—"))}
${row("最近错误", info.last_error_message ? esc(info.last_error_message) : "无", !info.last_error_message)}
${row("命令菜单", `${commandCount} / ${BOT_COMMANDS.length} 条`, cmdOk)}
${envRows}
</table>
<div class="btns">
  <a href="${esc(base)}/setup">⚡ 一键配置 / 重新同步</a>
  <a href="${esc(base)}">↻ 刷新状态</a>
  ${bot.username ? `<a href="https://t.me/${esc(bot.username)}" target="_blank" rel="noopener">✈ 打开 Telegram 机器人</a>` : ""}
</div>
<footer>仅管理员可通过 Telegram 使用本机器人；未授权访问将被重定向。</footer>
</body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Bot setup</title><pre>${esc(body)}</pre>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ---------------------------------------------------------------------------
// Authorization and dispatch
// ---------------------------------------------------------------------------

function isAdmin(from, env) {
  return !!from && String(from.id) === String(env.TG_ID).trim();
}

async function dispatch(update, env) {
  const from = update.callback_query?.from ?? update.message?.from;
  if (!isAdmin(from, env)) {
    // Silent rejection; the attempt is logged for auditing.
    console.warn("Unauthorized access attempt from user id:", from?.id);
    return;
  }
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message?.text) return handleMessage(update.message, env);
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const raw = msg.text.trim();
  const cmd = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
  const name = TEXT_ROUTES[cmd] || TEXT_ROUTES[raw];

  if (!name) {
    return render(env, chatId, null, {
      text: card("❔ 未识别的指令", "发送 /help 查看可用指令，或使用底部菜单。"),
      reply: REPLY_KEYBOARD,
    });
  }
  let view;
  try {
    view = await route(env, name, []);
  } catch (err) {
    view = errorView(err);
  }
  return render(env, chatId, null, view);
}

async function handleCallback(cq, env) {
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;
  const [op, ...args] = String(cq.data || "").split("|");

  await tgCall(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId) return;

  let view;
  try {
    view = await route(env, op, args);
  } catch (err) {
    console.error("callback error:", err);
    view = errorView(err);
  }
  return render(env, chatId, msgId, view);
}

async function route(env, op, a) {
  switch (op) {
    case "start":
    case "HM":
      return viewStart();
    case "help":
      return viewHelp();
    case "dashboard":
    case "DB":
      return viewDashboard(env);
    case "zones":
    case "ZL":
      return viewZones(env, toPage(a[0]));
    case "ZD":
      return viewZone(env, a[0]);
    case "DNS":
      return viewDns(env, a[0], toPage(a[1]));
    case "RC":
      return viewRecord(env, a[0], toPage(a[1]), Number(a[2]));
    case "TG":
      return toggleProxy(env, a[0], toPage(a[1]), Number(a[2]));
    case "DL":
      return viewDeleteConfirm(env, a[0], toPage(a[1]), Number(a[2]));
    case "DY":
      return deleteRecord(env, a[0], toPage(a[1]), Number(a[2]));
    case "workers":
    case "pages":
    case "WL":
      return viewList(env, a[0] === "p" || op === "pages" ? "p" : "w", toPage(op === "WL" ? a[1] : a[0]));
    case "WD":
      return viewItem(env, a[0] === "p" ? "p" : "w", Number(a[1]), toPage(a[2]));
    case "urls":
    case "UR":
      return viewUrls(env);
    case "NP":
      return null;
    default:
      throw new Error("未知操作，请返回主菜单重试。");
  }
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tgCall(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description);
  return data;
}

async function render(env, chatId, msgId, view) {
  if (!view) return;
  const base = {
    chat_id: chatId,
    text: trimHtml(view.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (msgId && !view.reply) {
    const r = await tgCall(env, "editMessageText", {
      ...base,
      message_id: msgId,
      reply_markup: view.markup,
    });
    if (r.ok || /not modified/i.test(r.description || "")) return;
  }
  await tgCall(env, "sendMessage", { ...base, reply_markup: view.reply || view.markup });
}

function trimHtml(text) {
  if (text.length <= 4000) return text;
  const cut = text.slice(0, 3900);
  return cut.slice(0, cut.lastIndexOf("\n")) + "\n…(内容过长已截断)";
}

// ---------------------------------------------------------------------------
// Cloudflare API client
// ---------------------------------------------------------------------------

function cfHeaders(env) {
  const key = String(env.CF_API_KEY).trim();
  const headers = { "Content-Type": "application/json" };
  if (/^[a-f0-9]{37}$/i.test(key)) {
    // Global API Key: requires the account email.
    headers["X-Auth-Key"] = key;
    headers["X-Auth-Email"] = String(env.CF_USER).trim();
  } else {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

async function cfFetch(env, path, { method = "GET", body, query } = {}) {
  const url = new URL(CF_API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: cfHeaders(env),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Cloudflare 返回非 JSON 响应 (HTTP ${res.status})`);
  if (!data.success) {
    const msg = (data.errors || []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${msg}`);
  }
  return data;
}

async function gql(env, query, variables) {
  const res = await fetch(`${CF_API}/graphql`, {
    method: "POST",
    headers: cfHeaders(env),
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; "));
  if (!data.data) throw new Error(`GraphQL HTTP ${res.status}`);
  return data.data;
}

async function getAccountId(env) {
  if (env.CF_ACCOUNT_ID) return String(env.CF_ACCOUNT_ID).trim();
  const user = String(env.CF_USER).trim();
  if (/^[a-f0-9]{32}$/i.test(user)) return user; // CF_USER holds an account ID
  if (!accountIdCache) {
    const d = await cfFetch(env, "/accounts", { query: { per_page: 5 } });
    if (!d.result?.length) throw new Error("该凭证下没有可用账户");
    accountIdCache = d.result[0].id;
  }
  return accountIdCache;
}

/** Fetches every page of a paginated list endpoint (bounded to 20 pages). */
async function listAll(env, path, query = {}) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await cfFetch(env, path, { query: { ...query, page, per_page: 50 } });
    out.push(...(d.result || []));
    const total = d.result_info?.total_pages ?? 1;
    if (page >= total) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data access: usage, zones, DNS, Workers, Pages
// ---------------------------------------------------------------------------

function utcDayWindow() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: now.toISOString() };
}

async function getUsage(env) {
  const accountTag = await getAccountId(env);
  const { start, end } = utcDayWindow();
  const vars = { accountTag, start, end };
  const head =
    "query($accountTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) {";
  const tail = "} } }";
  const filter = "(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end })";

  const [w, d, k] = await Promise.allSettled([
    gql(env, `${head} workersInvocationsAdaptive${filter} { sum { requests errors } } ${tail}`, vars),
    gql(env, `${head} d1AnalyticsAdaptiveGroups${filter} { sum { readQueries writeQueries rowsRead rowsWritten } } ${tail}`, vars),
    gql(env, `${head} kvOperationsAdaptiveGroups${filter} { dimensions { actionType } sum { requests } } ${tail}`, vars),
  ]);

  const account = (res) => (res.status === "fulfilled" ? res.value?.viewer?.accounts?.[0] : undefined);
  const fail = (res) => ({ ok: false, value: 0, error: res.reason?.message || "不可用" });
  const sumOf = (groups, field) => (groups || []).reduce((s, g) => s + Number(g.sum?.[field] ?? 0), 0);

  const wGroups = account(w)?.workersInvocationsAdaptive;
  const dGroups = account(d)?.d1AnalyticsAdaptiveGroups;
  const kGroups = account(k)?.kvOperationsAdaptiveGroups;

  let kvReads = 0;
  let kvWrites = 0;
  for (const g of kGroups || []) {
    const action = String(g.dimensions?.actionType || "").toLowerCase();
    const n = Number(g.sum?.requests || 0);
    if (["read", "get", "list", "metadata"].some((x) => action.includes(x))) kvReads += n;
    else kvWrites += n;
  }

  return {
    workersRequests: w.status === "fulfilled" ? { ok: true, value: sumOf(wGroups, "requests") } : fail(w),
    d1RowsRead: d.status === "fulfilled" ? { ok: true, value: sumOf(dGroups, "rowsRead") } : fail(d),
    d1RowsWritten: d.status === "fulfilled" ? { ok: true, value: sumOf(dGroups, "rowsWritten") } : fail(d),
    kvReads: k.status === "fulfilled" ? { ok: true, value: kvReads } : fail(k),
    kvWrites: k.status === "fulfilled" ? { ok: true, value: kvWrites } : fail(k),
  };
}

async function countZones(env) {
  const d = await cfFetch(env, "/zones", { query: { per_page: 1 } });
  return d.result_info?.total_count ?? d.result.length;
}

async function listWorkerScripts(env) {
  const acct = await getAccountId(env);
  const d = await cfFetch(env, `/accounts/${acct}/workers/scripts`);
  return (d.result || [])
    .map((s) => ({ name: s.id, modified: s.modified_on, created: s.created_on }))
    .sort(byName);
}

async function listProjects(env) {
  const acct = await getAccountId(env);
  const list = await listAll(env, `/accounts/${acct}/pages/projects`);
  return list
    .map((p) => ({
      name: p.name,
      modified: p.latest_deployment?.modified_on || p.created_on,
      raw: p,
    }))
    .sort(byName);
}

/** Full Workers details: dev URL, custom domains and routes per script. */
async function collectWorkers(env) {
  const acct = await getAccountId(env);
  const [scriptsRes, subRes, domainsRes, zonesRes] = await Promise.allSettled([
    listWorkerScripts(env),
    cfFetch(env, `/accounts/${acct}/workers/subdomain`).then((d) => d.result?.subdomain || null),
    cfFetch(env, `/accounts/${acct}/workers/domains`).then((d) => d.result || []),
    listAll(env, "/zones"),
  ]);
  if (scriptsRes.status === "rejected") throw scriptsRes.reason;

  const scripts = scriptsRes.value;
  const accountSub = val(subRes, null);
  const domains = val(domainsRes, []);
  const zones = val(zonesRes, []);

  const routeRes = await Promise.allSettled(
    zones.map((z) =>
      cfFetch(env, `/zones/${z.id}/workers/routes`).then((d) =>
        (d.result || []).map((r) => ({ ...r, zone: z.name }))
      )
    )
  );
  const routes = routeRes.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  const enabledRes = await Promise.allSettled(
    scripts.map((s) =>
      cfFetch(env, `/accounts/${acct}/workers/scripts/${encodeURIComponent(s.name)}/subdomain`).then(
        (d) => !!d.result?.enabled
      )
    )
  );

  return scripts.map((s, i) => {
    const enabled = enabledRes[i].status === "fulfilled" && enabledRes[i].value;
    return {
      name: s.name,
      modified: s.modified,
      created: s.created,
      devUrl: enabled && accountSub ? `https://${s.name}.${accountSub}.workers.dev` : null,
      domains: domains.filter((d) => d.service === s.name).map((d) => d.hostname),
      routes: routes.filter((r) => r.script === s.name).map((r) => r.pattern),
    };
  });
}

function val(res, fallback) {
  return res.status === "fulfilled" ? res.value : fallback;
}

const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));

function patternToUrl(pattern) {
  const host = String(pattern || "").replace(/\/\*$/, "").replace(/^\*\./, "");
  if (!host || host.includes("*")) return null;
  return `https://${host}`;
}

function urlHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

async function recordAt(env, zoneId, page, idx) {
  if (!Number.isInteger(idx) || idx < 0) throw new Error("无效的记录索引");
  const d = await cfFetch(env, `/zones/${zoneId}/dns_records`, {
    query: { page, per_page: PAGE_SIZE },
  });
  const r = d.result?.[idx];
  if (!r) throw new Error("记录列表已变化，请返回列表重新打开。");
  return r;
}

// ---------------------------------------------------------------------------
// Views: each returns { text, markup?, reply? }
// ---------------------------------------------------------------------------

function errorView(err) {
  return {
    text: card("⚠️ 操作失败", esc(err?.message || "未知错误")),
    markup: kb([HOME]),
  };
}

function viewStart() {
  return {
    text: card(
      "☁️ Cloudflare 管理台",
      "欢迎，管理员。\n\n" +
        "📊 监控仪表盘：免费额度用量播报\n" +
        "🌐 域名：Zones 与 DNS 记录管理\n" +
        "⚙️ Workers / 📄 Pages：项目详情与公网地址\n" +
        "🔗 公网地址：汇总所有项目链接\n\n" +
        "使用底部菜单或发送指令开始。"
    ),
    reply: REPLY_KEYBOARD,
  };
}

function viewHelp() {
  return {
    text: card(
      "📖 使用帮助",
      "/dashboard  监控仪表盘播报\n" +
        "/zones      托管域名列表\n" +
        "/workers    Workers 列表\n" +
        "/pages      Pages 列表\n" +
        "/urls       全部公网地址\n" +
        "/start      主菜单\n\n" +
        "DNS 记录卡片支持切换代理 (🟠/⚪️) 与删除。\n" +
        "仅 TG_ID 对应的管理员可以使用本机器人。"
    ),
    reply: REPLY_KEYBOARD,
  };
}

async function viewDashboard(env) {
  const [usageRes, zonesRes, workersRes, pagesRes] = await Promise.allSettled([
    getUsage(env),
    countZones(env),
    listWorkerScripts(env).then((l) => l.length),
    listProjects(env).then((l) => l.length),
  ]);
  const usage = usageRes.status === "fulfilled" ? usageRes.value : null;
  const metric = (key) =>
    usage?.[key] ?? { ok: false, value: 0, error: usageRes.reason?.message || "不可用" };

  const rows = [
    ["Workers Req", metric("workersRequests"), FREE_LIMITS.workersRequests],
    ["D1 Rows Read", metric("d1RowsRead"), FREE_LIMITS.d1RowsRead],
    ["D1 Rows Write", metric("d1RowsWritten"), FREE_LIMITS.d1RowsWritten],
    ["KV Reads", metric("kvReads"), FREE_LIMITS.kvReads],
    ["KV Writes", metric("kvWrites"), FREE_LIMITS.kvWrites],
  ];

  const pre = rows
    .map(([label, m, limit]) => {
      if (!m.ok) return `${label.padEnd(14)}N/A`;
      const { pct, bar } = progressBar(m.value, limit);
      const flag = pct >= 100 ? " !!" : pct >= 80 ? " !" : "";
      return (
        `${label.padEnd(14)}[${bar}] ${pct.toFixed(1).padStart(5)}%${flag}\n` +
        `${" ".repeat(14)}${num(m.value).padStart(12)} / ${num(limit)}`
      );
    })
    .join("\n\n");

  const ov = (r, label, icon) => `${icon} ${label}: <b>${r.status === "fulfilled" ? num(r.value) : "?"}</b>`;
  const warnings = [];
  if (!usage) warnings.push(`用量: ${usageRes.reason?.message || "不可用"}`);
  else for (const [k, m] of Object.entries(usage)) if (!m.ok) warnings.push(`${k}: ${m.error}`);

  const body = [
    `<pre>${esc(pre)}</pre>`,
    `📦 ${ov(zonesRes, "Zones", "🌐")}   ${ov(workersRes, "Workers", "⚙️")}   ${ov(pagesRes, "Pages", "📄")}`,
    warnings.length ? `\n⚠️ 部分指标不可用: ${esc(warnings.join("; "))}` : "",
    "\n🕒 统计窗口: UTC 今日 00:00 → 当前",
    "ℹ️ 免费额度每日 (UTC 00:00) 重置，数据来自 Cloudflare GraphQL Analytics。",
  ].join("\n");

  return {
    text: card("📊 监控仪表盘播报 (Dashboard Report)", body),
    markup: kb([
      [btn("🔄 刷新", "DB")],
      [btn("🌐 域名", "ZL|1"), btn("⚙️ Workers", "WL|w|1")],
      [btn("📄 Pages", "WL|p|1"), btn("🔗 公网地址", "UR")],
    ]),
  };
}

function progressBar(used, limit, width = 10) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const filled = Math.min(width, Math.round((Math.min(pct, 100) / 100) * width));
  return { pct, bar: "█".repeat(filled) + "░".repeat(width - filled) };
}

async function viewZones(env, page) {
  const d = await cfFetch(env, "/zones", { query: { page, per_page: PAGE_SIZE, order: "name" } });
  const info = d.result_info || {};
  const total = info.total_pages || 1;
  const zones = d.result || [];
  if (!zones.length) return { text: card("🌐 托管域名", "暂无托管域名。"), markup: kb([HOME]) };

  const lines = zones.map(
    (z, i) =>
      `${(page - 1) * PAGE_SIZE + i + 1}. <b>${esc(z.name)}</b>\n` +
      `    ${statusIcon(z.status)} ${esc(z.status)} · ${esc(z.plan?.name)}`
  );
  const rows = zones.map((z) => [btn(`🌐 ${z.name}`, `ZD|${z.id}`)]);
  rows.push(...pageNav("ZL", page, total));
  rows.push(HOME);
  return {
    text: card("🌐 托管域名 Zones", `第 ${page}/${total} 页 · 共 ${num(info.total_count ?? zones.length)} 个\n\n${lines.join("\n")}`),
    markup: kb(rows),
  };
}

function statusIcon(status) {
  if (status === "active") return "🟢";
  if (status === "pending") return "🟡";
  return "⚪️";
}

async function viewZone(env, zoneId) {
  const z = (await cfFetch(env, `/zones/${zoneId}`)).result;
  const body = [
    `<b>状态</b>      ${statusIcon(z.status)} ${esc(z.status)}`,
    `<b>套餐</b>      ${esc(z.plan?.name)}`,
    `<b>账户</b>      ${esc(z.account?.name)}`,
    `<b>暂停</b>      ${z.paused ? "是" : "否"}`,
    `<b>Zone ID</b>   <code>${esc(z.id)}</code>`,
    `<b>NS 服务器</b>`,
    `<pre>${esc((z.name_servers || []).join("\n") || "—")}</pre>`,
    `<b>创建于</b>    ${fmtDate(z.created_on)}`,
    `<b>激活于</b>    ${fmtDate(z.activated_on)}`,
  ].join("\n");
  return {
    text: card(`🌐 ${z.name}`, body),
    markup: kb([
      [btn("📋 DNS 记录", `DNS|${z.id}|1`)],
      [btn("⬅️ 返回域名列表", "ZL|1"), btn("🏠 主菜单", "HM")],
    ]),
  };
}

async function viewDns(env, zoneId, page) {
  const [zone, d] = await Promise.all([
    cfFetch(env, `/zones/${zoneId}`),
    cfFetch(env, `/zones/${zoneId}/dns_records`, { query: { page, per_page: PAGE_SIZE } }),
  ]);
  const info = d.result_info || {};
  const total = info.total_pages || 1;
  const records = d.result || [];

  const lines = records.length
    ? records.map(
        (r, i) =>
          `${(page - 1) * PAGE_SIZE + i + 1}. ${r.proxied ? "🟠" : "⚪️"} <code>${esc(r.type)}</code> ${esc(shorten(r.name, 40))}\n` +
          `    ↳ ${esc(shorten(r.content, 50))}`
      )
    : ["暂无 DNS 记录。"];

  const rows = records.map((r, i) => [
    btn(`${r.type} · ${shorten(r.name, 30)} ${r.proxied ? "🟠" : "⚪️"}`, `RC|${zoneId}|${page}|${i}`),
  ]);
  rows.push(...pageNav(`DNS|${zoneId}`, page, total));
  rows.push([btn("⬅️ 返回域名", `ZD|${zoneId}`), btn("🏠 主菜单", "HM")]);

  return {
    text: card(
      `📋 DNS · ${zone.result.name}`,
      `第 ${page}/${total} 页 · 共 ${num(info.total_count ?? records.length)} 条\n\n${lines.join("\n")}`
    ),
    markup: kb(rows),
  };
}

async function viewRecord(env, zoneId, page, idx, notice) {
  const r = await recordAt(env, zoneId, page, idx);
  const proxyText = r.proxiable
    ? r.proxied
      ? "🟠 已代理 (橙云)"
      : "⚪️ 仅 DNS (灰云)"
    : "该类型不支持代理";
  const body = [
    notice ? `✅ ${esc(notice)}\n` : "",
    `<b>类型</b>    <code>${esc(r.type)}</code>`,
    `<b>名称</b>    <code>${esc(r.name)}</code>`,
    `<b>内容</b>    <code>${esc(shorten(r.content, 200))}</code>`,
    `<b>TTL</b>     ${r.ttl === 1 ? "自动" : esc(r.ttl)}`,
    `<b>代理</b>    ${proxyText}`,
    r.priority != null ? `<b>优先级</b>  ${esc(r.priority)}` : "",
    r.comment ? `<b>备注</b>    ${esc(r.comment)}` : "",
    `<b>修改于</b>  ${fmtDate(r.modified_on)}`,
    `<b>Record ID</b> <code>${esc(r.id)}</code>`,
  ]
    .filter(Boolean)
    .join("\n");

  const rows = [];
  if (r.proxiable) {
    rows.push([btn(r.proxied ? "⚪️ 切换为仅 DNS" : "🟠 切换为代理", `TG|${zoneId}|${page}|${idx}`)]);
  }
  rows.push([btn("🗑 删除记录", `DL|${zoneId}|${page}|${idx}`)]);
  rows.push([btn("⬅️ 返回记录列表", `DNS|${zoneId}|${page}`), btn("🏠 主菜单", "HM")]);

  return { text: card("📝 DNS 记录详情", body), markup: kb(rows) };
}

async function toggleProxy(env, zoneId, page, idx) {
  const r = await recordAt(env, zoneId, page, idx);
  if (!r.proxiable) throw new Error("该记录类型不支持代理。");
  const next = !r.proxied;
  await cfFetch(env, `/zones/${zoneId}/dns_records/${r.id}`, {
    method: "PATCH",
    body: { proxied: next },
  });
  return viewRecord(env, zoneId, page, idx, `代理已${next ? "开启 🟠" : "关闭 ⚪️"}`);
}

async function viewDeleteConfirm(env, zoneId, page, idx) {
  const r = await recordAt(env, zoneId, page, idx);
  return {
    text: card(
      "⚠️ 确认删除 DNS 记录",
      `即将删除 <code>${esc(r.type)}</code> <code>${esc(r.name)}</code>\n此操作不可撤销。`
    ),
    markup: kb([
      [btn("🗑 确认删除", `DY|${zoneId}|${page}|${idx}`)],
      [btn("取消", `RC|${zoneId}|${page}|${idx}`)],
    ]),
  };
}

async function deleteRecord(env, zoneId, page, idx) {
  const r = await recordAt(env, zoneId, page, idx);
  await cfFetch(env, `/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" });
  const view = await viewDns(env, zoneId, page);
  view.text = `✅ 已删除 <code>${esc(r.type)}</code> <code>${esc(r.name)}</code>\n\n` + view.text;
  return view;
}

async function viewList(env, kind, page) {
  const items = kind === "w" ? await listWorkerScripts(env) : await listProjects(env);
  const title = kind === "w" ? "⚙️ Workers 列表" : "📄 Pages 项目列表";
  if (!items.length) {
    return {
      text: card(title, "暂无项目。"),
      markup: kb([[btn(kind === "w" ? "📄 查看 Pages" : "⚙️ 查看 Workers", `WL|${kind === "w" ? "p" : "w"}|1`)], HOME]),
    };
  }
  const total = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const p = Math.min(page, total);
  const off = (p - 1) * PAGE_SIZE;
  const slice = items.slice(off, off + PAGE_SIZE);

  const lines = slice.map(
    (it, i) => `${off + i + 1}. <b>${esc(it.name)}</b>\n    ↳ 更新 ${fmtDate(it.modified)}`
  );
  const rows = slice.map((it, i) => [
    btn(`${kind === "w" ? "⚙️" : "📄"} ${shorten(it.name, 36)}`, `WD|${kind}|${off + i}|${p}`),
  ]);
  rows.push(...pageNav(`WL|${kind}`, p, total));
  rows.push([
    btn(kind === "w" ? "📄 查看 Pages" : "⚙️ 查看 Workers", `WL|${kind === "w" ? "p" : "w"}|1`),
    btn("🔗 公网地址", "UR"),
  ]);
  rows.push(HOME);

  return {
    text: card(title, `第 ${p}/${total} 页 · 共 ${num(items.length)} 个\n\n${lines.join("\n")}`),
    markup: kb(rows),
  };
}

async function viewItem(env, kind, idx, page) {
  const acct = await getAccountId(env);
  if (kind === "w") {
    const list = await collectWorkers(env);
    const it = list[idx];
    if (!it) throw new Error("列表已变化，请返回重新打开。");
    const deployments = await cfFetch(
      env,
      `/accounts/${acct}/workers/scripts/${encodeURIComponent(it.name)}/deployments`
    )
      .then((d) => (Array.isArray(d.result?.deployments) ? d.result.deployments : Array.isArray(d.result) ? d.result : []))
      .catch(() => []);

    const body = [
      `<b>名称</b>        <code>${esc(it.name)}</code>`,
      `<b>最后更新</b>    ${fmtDate(it.modified)}`,
      `<b>创建于</b>      ${fmtDate(it.created)}`,
      `<b>workers.dev</b> ${it.devUrl ? esc(it.devUrl) : "未启用"}`,
      `<b>自定义域名</b>`,
      bullets(it.domains),
      `<b>路由 Routes</b>`,
      bullets(it.routes),
      `<b>最近部署</b>`,
      deployments.length
        ? deployments
            .slice(0, 3)
            .map((d) => `• ${fmtDate(d.created_on)} ${esc(d.source || "")}`)
            .join("\n")
        : "—",
    ].join("\n");

    const urls = uniqueUrls([
      it.devUrl,
      ...it.domains.map((h) => `https://${h}`),
      ...it.routes.map(patternToUrl),
    ]);
    const rows = urls.slice(0, 10).map((u) => [urlBtn(`🔗 ${urlHost(u)}`, u)]);
    rows.push([btn("⬅️ 返回 Workers", `WL|w|${page}`), btn("🏠 主菜单", "HM")]);
    return { text: card(`⚙️ ${it.name}`, body), markup: kb(rows) };
  }

  const projects = await listProjects(env);
  const p = projects[idx];
  if (!p) throw new Error("列表已变化，请返回重新打开。");
  const raw = p.raw;
  const deployments = await cfFetch(env, `/accounts/${acct}/pages/projects/${encodeURIComponent(p.name)}/deployments`, {
    query: { per_page: 3 },
  })
    .then((d) => d.result || [])
    .catch(() => []);

  const body = [
    `<b>名称</b>        <code>${esc(raw.name)}</code>`,
    `<b>子域名</b>      ${raw.subdomain ? esc(raw.subdomain) : "—"}`,
    `<b>生产分支</b>    ${esc(raw.production_branch)}`,
    `<b>最后更新</b>    ${fmtDate(p.modified)}`,
    `<b>创建于</b>      ${fmtDate(raw.created_on)}`,
    `<b>自定义域名</b>`,
    bullets(raw.domains || []),
    `<b>最近部署</b>`,
    deployments.length
      ? deployments
          .map((d) => `• ${fmtDate(d.created_on)} · ${esc(d.environment)} · ${esc(d.latest_stage?.name ?? "—")}`)
          .join("\n")
      : "—",
  ].join("\n");

  const urls = uniqueUrls([
    raw.subdomain ? `https://${raw.subdomain}` : null,
    raw.canonical_deployment?.url,
    ...(raw.domains || []).map((h) => `https://${h}`),
  ]);
  const rows = urls.slice(0, 10).map((u) => [urlBtn(`🔗 ${urlHost(u)}`, u)]);
  rows.push([btn("⬅️ 返回 Pages", `WL|p|${page}`), btn("🏠 主菜单", "HM")]);
  return { text: card(`📄 ${raw.name}`, body), markup: kb(rows) };
}

async function viewUrls(env) {
  const [wRes, pRes] = await Promise.allSettled([collectWorkers(env), listProjects(env)]);
  const entries = [];
  const warnings = [];

  if (wRes.status === "fulfilled") {
    for (const w of wRes.value) {
      for (const u of uniqueUrls([w.devUrl, ...w.domains.map((h) => `https://${h}`), ...w.routes.map(patternToUrl)])) {
        entries.push({ group: "Workers", name: w.name, url: u });
      }
    }
  } else warnings.push(`Workers: ${wRes.reason?.message}`);

  if (pRes.status === "fulfilled") {
    for (const p of pRes.value) {
      const raw = p.raw;
      for (const u of uniqueUrls([
        raw.subdomain ? `https://${raw.subdomain}` : null,
        raw.canonical_deployment?.url,
        ...(raw.domains || []).map((h) => `https://${h}`),
      ])) {
        entries.push({ group: "Pages", name: p.name, url: u });
      }
    }
  } else warnings.push(`Pages: ${pRes.reason?.message}`);

  if (!entries.length) {
    return {
      text: card("🔗 公网地址", warnings.length ? esc(warnings.join("; ")) : "暂无公网地址。"),
      markup: kb([HOME]),
    };
  }

  const groups = new Map();
  for (const e of entries) {
    const key = `${e.group}|${e.name}`;
    if (!groups.has(key)) groups.set(key, { group: e.group, name: e.name, urls: [] });
    groups.get(key).urls.push(e.url);
  }
  const lines = [];
  for (const g of groups.values()) {
    lines.push(`${g.group === "Workers" ? "⚙️" : "📄"} <b>${esc(g.name)}</b>`);
    for (const u of g.urls) lines.push(`    ↳ ${esc(u)}`);
  }
  const shownLines = lines.slice(0, 120).join("\n");
  const more = lines.length > 120 ? "\n…(更多地址请使用下方按钮)" : "";

  const rows = entries
    .slice(0, MAX_URL_BUTTONS)
    .map((e) => [urlBtn(`${e.group === "Workers" ? "⚙️" : "📄"} ${shorten(e.name, 20)} · ${shorten(urlHost(e.url), 24)}`, e.url)]);
  if (entries.length > MAX_URL_BUTTONS) rows.push([btn(`…另有 ${entries.length - MAX_URL_BUTTONS} 个地址`, "NP")]);
  rows.push([btn("⚙️ Workers", "WL|w|1"), btn("📄 Pages", "WL|p|1")]);
  rows.push([btn("🔄 刷新", "UR"), btn("🏠 主菜单", "HM")]);

  const warnNote = warnings.length ? `\n\n⚠️ 部分数据不可用: ${esc(warnings.join("; "))}` : "";
  return {
    text: card("🔗 全部项目公网地址", `共 ${num(entries.length)} 个地址\n\n${shownLines}${more}${warnNote}`),
    markup: kb(rows),
  };
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

const HOME = [btn("🏠 主菜单", "HM")];

function card(title, body) {
  return `<b>${esc(title)}</b>\n━━━━━━━━━━━━━━━━\n${body}`;
}

function btn(text, data) {
  return { text: shorten(text, 60), callback_data: data };
}

function urlBtn(text, url) {
  return { text: shorten(text, 60), url };
}

function kb(rows) {
  return { inline_keyboard: rows.filter((r) => r && r.length) };
}

function pageNav(prefix, page, total) {
  if (total <= 1) return [];
  return [
    [
      page > 1 ? btn("◀️", `${prefix}|${page - 1}`) : btn("·", "NP"),
      btn(`${page} / ${total}`, "NP"),
      page < total ? btn("▶️", `${prefix}|${page + 1}`) : btn("·", "NP"),
    ],
  ];
}

function bullets(arr) {
  return arr && arr.length ? arr.map((x) => `• ${esc(x)}`).join("\n") : "—";
}

function uniqueUrls(list) {
  return [...new Set(list.filter((u) => typeof u === "string" && u.startsWith("https://")))];
}

function toPage(x) {
  return Math.max(1, parseInt(x || "1", 10) || 1);
}

function esc(s) {
  return String(s ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function num(n) {
  return Number(n ?? 0).toLocaleString("en-US");
}

function shorten(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? esc(s) : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
