// 数据源层(M6):天气 / 日历(ICS) / 待办 / 服务器探活 / Agent 探活 / AI 用量。
//
// 原则:
//  - 所有外部源可配置(Admin/env),未配置或拉取失败一律回退 null,
//    由渲染层显示占位文案,绝不影响 frame 出图
//  - 天气用 Open-Meteo:免费、无需 API key,凭据零负担
//  - 进程内 TTL 缓存 + 最近一次成功值兜底:外部源抖动时画面保持旧数据

import { getConfig } from "./storage.js";
import { isSafePublicHttpUrl } from "./urlguard.js";

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;

/** @type {Map<string, {ts: number, data: any}>} */
const cache = new Map();
/** @type {Map<string, any>} 最近一次成功数据(源失败时兜底) */
const lastGood = new Map();

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
	// 请求发起前复核(配置可能在持久化层之外被改动;纵深防御)
	if (!isSafePublicHttpUrl(url)) throw new Error(`blocked by urlguard: ${url}`);
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { "User-Agent": "leaf5-dashboard/0.1" },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.text();
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
	const horizon = Date.now() + horizonDays * 86_400_000;
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).split(";")[0].toUpperCase();
		const val = line.slice(idx + 1).trim();
		if (key === "BEGIN" && val === "VEVENT") cur = {};
		else if (key === "END" && val === "VEVENT") {
			if (cur?.start && cur.start.getTime() <= horizon && cur.summary) events.push(cur);
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
	if (!isSafePublicHttpUrl(url)) return { name, up: false, ms: null };
	const start = Date.now();
	try {
		await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return { name, up: true, ms: Date.now() - start };
	} catch {
		return { name, up: false, ms: null };
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

// ---- AI 用量(任意 JSON 端点) ----

export function fetchAiUsage() {
	const { aiUsageUrl } = getConfig();
	if (!aiUsageUrl) return Promise.resolve(null);
	return cached("aiUsage", async () => {
		const j = await fetchJson(aiUsageUrl);
		// 期望 {label, used, quota} 或 {label, text};字段缺失按 null 交给占位
		return {
			label: typeof j.label === "string" ? j.label : "AI",
			used: Number.isFinite(Number(j.used)) ? Number(j.used) : null,
			quota: Number.isFinite(Number(j.quota)) ? Number(j.quota) : null,
			text: typeof j.text === "string" ? j.text : null,
		};
	});
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

export function startBackgroundRefresh() {
	if (refreshTimer) return;
	// 启动即拉一次(不 await,不阻塞 listen),此后定时刷新
	refreshSnapshot().catch(() => {});
	refreshTimer = setInterval(() => {
		refreshSnapshot().catch(() => {});
	}, CACHE_TTL_MS);
	refreshTimer.unref();
}

export function getSnapshotData() {
	const { todos } = getConfig();
	return { ...snapshot, todos: todos ?? [] };
}
