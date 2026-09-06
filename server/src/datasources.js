// 数据源层(M6):天气 / 日历(ICS) / 待办 / 服务器探活 / Agent 探活 / AI 用量。
//
// 原则:
//  - 所有外部源可配置(Admin/env),未配置或拉取失败一律回退 null,
//    由渲染层显示占位文案,绝不影响 frame 出图
//  - 天气用 Open-Meteo:免费、无需 API key,凭据零负担
//  - 进程内 TTL 缓存 + 最近一次成功值兜底:外部源抖动时画面保持旧数据

import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "./storage.js";
import { isSafePublicHttpUrl, isPrivateAddress } from "./urlguard.js";

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** @type {Map<string, {ts: number, data: any}>} */
const cache = new Map();
/** @type {Map<string, any>} 最近一次成功数据(源失败时兜底) */
const lastGood = new Map();

/** 主机名文本层校验:拒绝 localhost/私网/环回/链路本地/保留段字面量与保留域 */
function assertPublicHostname(hostname) {
	if (
		/(^|\.)(localhost|local|internal|ip6-localhost)$/i.test(hostname) ||
		hostname === "::1" ||
		hostname.startsWith("[::") ||
		hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80") ||
		/^(127|10|0)\./.test(hostname) ||
		/^169\.254\./.test(hostname) ||
		/^192\.168\./.test(hostname) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
	) {
		throw new Error(`blocked host: ${hostname}`);
	}
}

/**
 * 解析 URL 并做完整 SSRF 校验:协议白名单 → 主机名文本校验 →
 * DNS 解析全部 A/AAAA 记录逐个确认非私网(防 DNS rebinding)。
 * @returns {Promise<URL>}
 */
async function resolveValidatedUrl(urlStr) {
	const u = new URL(urlStr);
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`blocked protocol: ${u.protocol}`);
	}
	const host = u.hostname;
	if (!host) throw new Error("empty host");
	assertPublicHostname(host);
	// DNS 层:域名可能解析到内网(例如 169.254.169.254 云元数据),逐记录校验
	const addrs = await dns.promises.lookup(host, { all: true });
	for (const { address } of addrs) {
		if (isPrivateAddress(address)) {
			throw new Error(`blocked dns: ${host} -> ${address}`);
		}
	}
	return u;
}

/** 单次请求(redirect: manual),由 fetchText 循环处理跳转并逐跳校验 */
async function fetchOnce(u, timeoutMs, extraHeaders) {
	const res = await fetch(u, {
		redirect: "manual",
		signal: AbortSignal.timeout(timeoutMs),
		headers: { "User-Agent": "leaf5-dashboard/0.1", ...extraHeaders },
	});
	return res;
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS, extraHeaders = {}) {
	// 请求发起前就地校验;重定向逐跳重新解析+校验(防 302 跳内网)。
	// Authorization 不允许跨 origin 重定向(凭据不得泄露给其他站点)
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const u = await resolveValidatedUrl(current);
		const res = await fetchOnce(u, timeoutMs, extraHeaders);
		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`redirect ${res.status} without location`);
			res.body?.cancel?.();
			const next = new URL(location, u);
			const crossOrigin =
				next.origin !== u.origin ||
				next.protocol !== u.protocol;
			if (crossOrigin && "Authorization" in extraHeaders) {
				throw new Error(
					`blocked cross-origin redirect with Authorization: ${u.origin} -> ${next.origin}`,
				);
			}
			current = next.toString();
			continue;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.text();
	}
	throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
	return JSON.parse(await fetchText(url, timeoutMs));
}

async function cached(key, loader) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
	try {
		const data = await loader();
		if (data != null) {
			cache.set(key, { ts: Date.now(), data });
			lastGood.set(key, data);
		}
		return data;
	} catch (err) {
		console.warn(`[datasource] ${key} failed: ${err.message}, fallback to last good`);
		return lastGood.get(key) ?? null;
	}
}

// ---- 天气(Open-Meteo,无 key) ----

// WMO 天气码 -> 中文短句(E-Ink 黑白文案,尽量短)
const WMO_TEXT = new Map([
	[0, "晴"], [1, "大致晴"], [2, "少云"], [3, "阴"],
	[45, "雾"], [48, "雾凇"], [51, "毛毛雨"], [53, "毛毛雨"], [55, "毛毛雨"],
	[61, "小雨"], [63, "中雨"], [65, "大雨"], [66, "冻雨"], [67, "冻雨"],
	[71, "小雪"], [73, "中雪"], [75, "大雪"], [77, "雪粒"],
	[80, "阵雨"], [81, "阵雨"], [82, "强阵雨"], [85, "阵雪"], [86, "阵雪"],
	[95, "雷雨"], [96, "雷雨冰雹"], [99, "雷雨冰雹"],
]);

export function fetchWeather() {
	const { weatherLat, weatherLon } = getConfig();
	const url =
		`https://api.open-meteo.com/v1/forecast?latitude=${weatherLat}` +
		`&longitude=${weatherLon}&current=temperature_2m,weather_code` +
		`&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
	return cached("weather", async () => {
		const j = await fetchJson(url);
		const cur = j.current;
		const daily = j.daily;
		return {
			temp: Math.round(cur.temperature_2m),
			cond: WMO_TEXT.get(cur.weather_code) ?? "—",
			high: Math.round(daily.temperature_2m_max[0]),
			low: Math.round(daily.temperature_2m_min[0]),
		};
	});
}

// ---- 日历(ICS 订阅,取未来 7 天事件) ----

// 轻量 ICS 解析:折叠行 -> DTSTART/DTEND/SUMMARY;只支持 DATE/DATE-TIME 两种形式,
// 复杂 RRULE 不展开(个人仪表盘够用;RRULE 事件只显示首个实例)
function parseIcs(text, horizonDays = 7) {
	const lines = [];
	for (const raw of text.split(/\r?\n/)) {
		// RFC5545 折叠行:以空格开头的行续接上一行
		if (/^[ \t]/.test(raw) && lines.length) {
			lines[lines.length - 1] += raw.slice(1);
		} else {
			lines.push(raw);
		}
	}

	const icsDt = (v) => {
		// 形如 20260905T120000Z / 20260905T120000 / 20260905
		const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/);
		if (!m) return null;
		const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
		// 带_Z 的是 UTC;朴素本地时间按本地处理(误差对" upcoming 列表"可接受)
		const dt = v.endsWith("Z")
			? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
			: new Date(+y, +mo - 1, +d, +h, +mi, +s);
		return Number.isNaN(dt.getTime()) ? null : dt;
	};

	const events = [];
	let cur = null;
	const now = Date.now();
	const horizon = now + horizonDays * 86_400_000;
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).split(";")[0].toUpperCase();
		const val = line.slice(idx + 1).trim();
		if (key === "BEGIN" && val === "VEVENT") cur = {};
		else if (key === "END" && val === "VEVENT") {
			// 只收 [now, horizon] 内的事件:历史事件不允许出现在"近 7 天"
			if (
				cur?.start && cur.summary &&
				cur.start.getTime() >= now &&
				cur.start.getTime() <= horizon
			) {
				events.push(cur);
			}
			cur = null;
		} else if (cur) {
			if (key === "DTSTART") cur.start = icsDt(val);
			else if (key === "DTEND") cur.end = icsDt(val);
			else if (key === "SUMMARY") cur.summary = val.replace(/\\,/g, ",").replace(/\\n/g, " ");
		}
	}
	return events
		.filter((e) => e.start)
		.sort((a, b) => a.start - b.start)
		.slice(0, 8);
}

export function fetchEvents() {
	const { icsUrl } = getConfig();
	if (!icsUrl) return Promise.resolve(null);
	return cached("events", async () => parseIcs(await fetchText(icsUrl)));
}

// ---- 服务器 / Agent 探活 ----

async function probeOne({ name, url }) {
	if (!isSafePublicHttpUrl(url)) return { name, up: false, ms: null, status: null };
	const start = Date.now();
	try {
		// DNS 解析校验(防 rebinding);探活以 HTTP 成功状态(2xx)判定
		const u = await resolveValidatedUrl(url);
		const res = await fetch(u, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "manual",
		});
		return { name, up: res.ok, status: res.status, ms: Date.now() - start };
	} catch {
		return { name, up: false, ms: null, status: null };
	}
}

async function probeList(key) {
	const cfgKey = key === "servers" ? "servers" : "agents";
	const list = getConfig()[cfgKey];
	if (!list.length) return null;
	const results = await Promise.all(list.map(probeOne));
	// 上线数摘要放第一个元素之外,渲染层自己算
	return results;
}

export const fetchServers = () => cached("servers", () => probeList("servers"));
export const fetchAgents = () => cached("agents", () => probeList("agents"));

// ---- AI 用量(codex / zai(GLM) / kimi / custom 通用 JSON) ----
//
// 统一产出行结构:{ name, label, plan?, windows: [{label, pct}], text? }
//  - windows 内 pct 为 0-100 已用百分比,渲染层取最大值当主显示
//  - 源失败抛错,由 fetchOneAiSource 转为 null,渲染层显示"获取失败"

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI 的公共 OAuth client id(刷新 access_token 用,非机密)
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function aiWindowLabelBySeconds(sec) {
	if (sec >= 604_800) return "本周";
	if (sec >= 18_000) return "5小时";
	const hours = Math.round(sec / 3600);
	return hours > 0 ? `${hours}小时` : "限时";
}

// Codex(ChatGPT 订阅):GET wham/usage,Bearer + ChatGPT-Account-Id 双头;
// access_token 过期(401)时用 refresh_token 换新并原子写回 auth.json,
// 与 Codex CLI 共享同一份登录态(它自己也会刷新,谁先刷到谁落盘)
async function fetchCodexUsage() {
	const authFile = path.join(os.homedir(), ".codex", "auth.json");
	const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
	const tokens = auth.tokens ?? {};
	if (!tokens.access_token || !tokens.account_id) {
		throw new Error("auth.json 缺少 access_token/account_id,请先 codex login");
	}

	async function request(accessToken) {
		// 端点为代码内常量,仍在发起前就地校验 host(SSRF 纵深防御)
		if (!isSafePublicHttpUrl(CODEX_USAGE_URL) || !isSafePublicHttpUrl(CODEX_TOKEN_URL)) {
			throw new Error("codex endpoint blocked by urlguard");
		}
		const res = await fetch(CODEX_USAGE_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"ChatGPT-Account-Id": tokens.account_id,
				"User-Agent": "codex_cli_rs/0.48.0",
			},
		});
		return { status: res.status, data: res.ok ? await res.json() : null };
	}

	let { status, data } = await request(tokens.access_token);
	if (status === 401 && tokens.refresh_token) {
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: CODEX_CLIENT_ID,
		});
		const res = await fetch(CODEX_TOKEN_URL, {
			method: "POST",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!res.ok) throw new Error(`codex token refresh HTTP ${res.status}`);
		const fresh = await res.json();
		if (!fresh.access_token) throw new Error("codex token refresh 无 access_token");
		// 原子写回(保持 0600):refresh_token 可能轮换,落盘避免下次又刷
		const merged = { ...tokens, access_token: fresh.access_token, ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}) };
		const tmp = `${authFile}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...auth, tokens: merged }, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, authFile);
		({ status, data } = await request(fresh.access_token));
	}
	if (status !== 200 || !data) throw new Error(`codex usage HTTP ${status}`);

	const rl = data.rate_limit ?? {};
	const windows = [];
	for (const w of [rl.primary_window, rl.secondary_window]) {
		if (w && Number.isFinite(Number(w.used_percent))) {
			windows.push({
				label: aiWindowLabelBySeconds(Number(w.limit_window_seconds) || 0),
				pct: Math.round(Number(w.used_percent)),
			});
		}
	}
	return {
		label: "Codex",
		plan: typeof data.plan_type === "string" ? data.plan_type.toUpperCase() : null,
		windows,
	};
}

// GLM Coding Plan(bigmodel.cn / z.ai):Authorization 直接放 key,无 Bearer 前缀。
// TOKENS_LIMIT 条目即 token 用量窗口(5h/周),TIME_LIMIT 是 MCP 月度调用,不展示
async function fetchZaiUsage(url) {
	const key = process.env.ZAI_API_KEY;
	if (!key) throw new Error("ZAI_API_KEY 未设置");
	const j = JSON.parse(await fetchText(url, FETCH_TIMEOUT_MS, { Authorization: key }));
	if (!j?.success || !j.data) throw new Error(`zai 响应异常: ${j.msg ?? "unknown"}`);
	const windows = (j.data.limits ?? [])
		.filter((l) => l?.type === "TOKENS_LIMIT" && Number.isFinite(Number(l.percentage)))
		.map((l) => ({
			// unit 实测:3=小时(配 number=5)、6=周;其余码值兜底成原始数字
			label: l.unit === 3 ? `${l.number}小时` : l.unit === 6 ? "每周" : `窗口${l.unit}`,
			pct: Math.round(Number(l.percentage)),
		}));
	return {
		label: "GLM",
		plan: typeof j.data.level === "string" ? j.data.level.toUpperCase() : null,
		windows,
	};
}

// Kimi For Coding:Bearer key;usage 是套餐总额度摘要,limits[] 是滑动窗口;
// 数值字段全是字符串,统一 Number() 换算;已用百分比 = (limit-remaining)/limit
function kimiPct(detail) {
	const limit = Number(detail?.limit);
	const remaining = Number(detail?.remaining);
	if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
	return Math.round(((limit - remaining) / limit) * 100);
}

function kimiWindowLabel(window) {
	const dur = Number(window?.duration);
	const unit = String(window?.timeUnit ?? "");
	if (!Number.isFinite(dur)) return "限额";
	if (unit.includes("MINUTE")) return dur >= 60 && dur % 60 === 0 ? `${dur / 60}小时` : `${dur}分钟`;
	if (unit.includes("HOUR")) return `${dur}小时`;
	if (unit.includes("WEEK")) return "本周";
	if (unit.includes("DAY")) return `${dur}天`;
	if (unit.includes("MONTH")) return "本月";
	return "限额";
}

async function fetchKimiUsage(url) {
	const key = process.env.KIMI_API_KEY ?? process.env.KIMI_CODING_API_KEY;
	if (!key) throw new Error("KIMI_API_KEY 未设置");
	const j = JSON.parse(
		await fetchText(url, FETCH_TIMEOUT_MS, {
			Authorization: `Bearer ${key}`,
			"User-Agent": "KimiCLI/1.6",
		}),
	);
	const windows = [];
	const summaryPct = kimiPct(j.usage);
	if (summaryPct != null) windows.push({ label: "套餐", pct: summaryPct });
	for (const item of j.limits ?? []) {
		const pct = kimiPct(item?.detail);
		if (pct != null) windows.push({ label: kimiWindowLabel(item?.window), pct });
	}
	return { label: "Kimi", plan: null, windows };
}

// custom:保持 M6 的通用 JSON 约定 {label, used, quota} 或 {label, text}
async function fetchCustomUsage(url) {
	const j = JSON.parse(await fetchText(url));
	return {
		label: typeof j.label === "string" ? j.label : "AI",
		text: typeof j.text === "string" ? j.text : null,
		windows:
			Number.isFinite(Number(j.used)) && Number.isFinite(Number(j.quota)) && Number(j.quota) > 0
				? [{ label: "已用", pct: Math.round((Number(j.used) / Number(j.quota)) * 100) }]
				: Number.isFinite(Number(j.used))
					? [{ label: "已用", pct: Math.min(100, Math.round(Number(j.used))) }]
					: [],
	};
}

const AI_ADAPTERS = {
	codex: () => fetchCodexUsage(),
	zai: (src) => fetchZaiUsage(src.url),
	kimi: (src) => fetchKimiUsage(src.url),
	custom: (src) => fetchCustomUsage(src.url),
};

const AI_SOURCE_LABELS = { codex: "Codex", zai: "GLM", kimi: "Kimi", custom: "AI" };

async function fetchOneAiSource(src) {
	try {
		// zai/kimi/custom 的 url 来自 Admin 可写配置,发起前就地校验(SSRF 防护);
		// codex 无外部 url,走常量端点并在 fetchCodexUsage 内自校验
		if (src.url && !isSafePublicHttpUrl(src.url)) {
			console.warn(`[datasource] aiUsage:${src.name} blocked by urlguard`);
			return null;
		}
		const row = await AI_ADAPTERS[src.name](src);
		if (!row) return null;
		return { name: src.name, label: AI_SOURCE_LABELS[src.name] ?? src.name, ...row };
	} catch (err) {
		console.warn(`[datasource] aiUsage:${src.name} failed: ${err.message}`);
		return null; // cached() 会自动落到 lastGood 兜底
	}
}

/** @returns {Promise<Array<{name, label, plan?, windows?, text?} | null>>} 与配置顺序一致 */
export function fetchAiUsage() {
	const sources = getConfig().aiUsage;
	if (!sources.length) return Promise.resolve([]);
	return Promise.all(
		sources.map((src) => cached(`aiUsage:${src.name}:${src.url}`, () => fetchOneAiSource(src))),
	);
}

// ---- 快照:后台定时刷新,请求路径只读内存,零网络调用 ----
//
// frame 请求路径不发起任何网络请求(也是 SSRF 纵深防御的一部分):
// 外部源由 startBackgroundRefresh 每 5 分钟拉一次,失败保留上次成功值;
// todos 属本地配置,读取时实时取,Admin 改完下一帧即生效。

const snapshot = {
	weather: null,
	events: null,
	servers: null,
	agents: null,
	aiUsage: null,
	snapshotAt: 0,
};

async function refreshSnapshot() {
	const [weather, events, servers, agents, aiUsage] = await Promise.all([
		fetchWeather(),
		fetchEvents(),
		fetchServers(),
		fetchAgents(),
		fetchAiUsage(),
	]);
	Object.assign(snapshot, {
		weather,
		events,
		servers,
		agents,
		aiUsage,
		snapshotAt: Date.now(),
	});
}

let refreshTimer = null;

let refreshSoonTimer = null;

export function startBackgroundRefresh() {
	if (refreshTimer) return;
	// 启动即拉一次(不 await,不阻塞 listen),此后定时刷新
	refreshSnapshot().catch(() => {});
	refreshTimer = setInterval(() => {
		refreshSnapshot().catch(() => {});
	}, CACHE_TTL_MS);
	refreshTimer.unref();
}

// 配置变更后尽快刷新快照(去抖 1s);否则新数据源要等最多 5 分钟才出画面。
// 同时清空 TTL 缓存与 lastGood:避免旧配置的数据串进新配置
// (例:ICS 从 A 改到 B,B 拉取失败时不应继续显示 A 的日程)
export function refreshSoon() {
	cache.clear();
	lastGood.clear();
	clearTimeout(refreshSoonTimer);
	refreshSoonTimer = setTimeout(() => {
		refreshSnapshot().catch(() => {});
	}, 1_000);
	refreshSoonTimer.unref?.();
}

export function getSnapshotData() {
	const { todos } = getConfig();
	return { ...snapshot, todos: todos ?? [] };
}
