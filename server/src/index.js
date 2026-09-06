// BOOX Leaf5+ E-Ink Dashboard 服务端(MVP)
//
// 接口:
//   GET /healthz                          -> { ok: true }
//   GET /api/device/:deviceId/status      -> { version, updatedAt, refresh, page }
//   GET /api/device/:deviceId/frame       -> image/png (1680x1264), ?page=home
//
// 版本策略:MVP 阶段时间驱动 —— version = floor(epochMinutes),
// 与大时钟 HH:MM 内容变化节奏一致,每分钟自然 +1。

import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	currentVersion,
	formatUpdatedAt,
	renderFrame,
	FRAME_WIDTH,
	FRAME_HEIGHT,
	PAGES,
} from "./renderer.js";
import {
	initStore,
	touchDevice,
	listDevices,
	getConfig,
	getConfigRev,
	updateConfig,
	flushDevices,
	setDesiredPage,
	bumpDeviceSignal,
} from "./storage.js";
import { startBackgroundRefresh, getSnapshotData, refreshSoon } from "./datasources.js";

initStore();
startBackgroundRefresh();
// 与快照同节奏周期渲染落盘(首次在模块尾部定义后立即执行)
setInterval(() => persistFrames().catch((err) => console.error("[leaf5-dashboard] frame persist:", err.message)), 60_000).unref();

// 轻量 .env 加载:凭据(API key)只进环境变量,不进 config.json。
// 不覆盖已有的同名 env(显式 export 优先);文件不存在时静默跳过。
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
try {
	for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (m && !(m[1] in process.env)) {
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
} catch {
	// 无 .env:所有走 env 的凭据项会以"未设置"报错,属正常可选配置
}

// 设备注册表节流落盘:10s 一次,进程退出时丢失最多 10s 心跳,可接受
setInterval(flushDevices, 10_000).unref();

const DEFAULT_PAGE = "home";

// 默认端口 39871:本机 3300 被其他长期服务占用,避开常见开发端口。
// PORT 解析后必须校验:非法值(如 PORT=abc)会让 listen(NaN) 抛出同步
// RangeError,error 事件兜不住,所以在这里直接中文提示后退出。
const PORT = Number.parseInt(process.env.PORT ?? "39871", 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT >= 65536) {
	console.error(
		`[leaf5-dashboard] 启动失败:PORT 环境变量 "${process.env.PORT}" 不是合法端口号(1-65535)。请换一个端口,例如:PORT=39872 npm start`,
	);
	process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// 统一解析 ?page=:仅接受 PAGES 内的单个字符串值;多值/非字符串/空串/
// 未知页面名一律回退 home,status 与 frame 两个端点行为保持一致
function getPageParam(query) {
	const page = query.page;
	return PAGES.includes(page) ? page : DEFAULT_PAGE;
}

// 请求日志:一行一条(时间 IP 方法 路径 状态 耗时)。必须挂在所有路由之前,
// 否则先注册的路由命中后不会经过此中间件,API 请求将永远无日志(实测踩过)
app.use((req, res, next) => {
	const start = Date.now();
	res.on("finish", () => {
		console.log(
			`[req] ${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`,
		);
	});
	next();
});

app.get("/healthz", (_req, res) => {
	res.json({ ok: true });
});

// ---- Leaf Runtime 1.0:frame 文件服务 ----
// 各页 PNG 由后台周期渲染落盘(storage/frames/<page>.png),用静态中间件出文件:
// 响应路径零动态代码。必须在 /:deviceId 路由之前注册。
const FRAMES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"storage",
	"frames",
);
app.use("/api/device/frame", express.static(FRAMES_DIR, { maxAge: 0 }));

// 周期渲染全部页面并原子落盘(sha 变了才重写,避免无谓磁盘写)
let lastWrittenSha = new Map();
async function persistFrames() {
	for (const page of PAGES) {
		const entry = await renderPageCached(page);
		if (lastWrittenSha.get(page) === entry.sha256) continue;
		lastWrittenSha.set(page, entry.sha256);
		const target = path.join(FRAMES_DIR, `${page}.png`);
		fs.mkdirSync(FRAMES_DIR, { recursive: true });
		const tmp = `${target}.tmp`;
		fs.writeFileSync(tmp, entry.buffer);
		fs.renameSync(tmp, target);
	}
}

// ---- Leaf Runtime 1.0:共享页渲染缓存 ----
// 顶/底栏已移除,frame 内容只取决于(页面, 分钟, 数据快照),与设备无关,
// 所有设备共享同一份渲染产物;sha256 同时作为 page.version(取前 8 位十六进制)
import { createHash } from "node:crypto";

const pageRenderCache = new Map();
const PAGE_RENDER_CACHE_MAX = 24;

async function renderPageCached(page) {
	const minute = Math.floor(Date.now() / 60_000);
	const snapshotAt = getSnapshotData().snapshotAt;
	const key = `${page}:${minute}:${snapshotAt}`;
	const hit = pageRenderCache.get(key);
	if (hit) return hit;
	const buffer = await renderFrame({ page, version: minute, deviceId: "shared" });
	const sha256 = createHash("sha256").update(buffer).digest("hex");
	const entry = {
		buffer,
		sha256,
		version: Number.parseInt(sha256.slice(0, 8), 16),
		minute,
	};
	pageRenderCache.set(key, entry);
	if (pageRenderCache.size > PAGE_RENDER_CACHE_MAX) {
		pageRenderCache.delete(pageRenderCache.keys().next().value);
	}
	return entry;
}

// ---- Leaf Runtime 1.0:Manifest API ----
// 客户端单次请求获取全部同步所需信息:按页 version/sha256 差量下载,
// configVersion 感知刷新策略变化,desiredPage 接收远程切页指令
app.get("/api/device/:deviceId/manifest", async (req, res, next) => {
	try {
		// deviceId 白名单化(字母数字与连字符),阻断任意字符进入响应与 URL
		const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
		const config = getConfig();
		touchDevice(deviceId, {});

		const pages = [];
		let contentVersion = 0;
		for (const page of PAGES) {
			const entry = await renderPageCached(page);
			contentVersion = Math.max(contentVersion, entry.version);
			pages.push({
				id: page,
				version: entry.version,
				sha256: entry.sha256,
			});
		}

		const deviceRec = listDevices().find((d) => d.deviceId === deviceId);
		res.set("Cache-Control", "no-store");
		res.json({
			configVersion: getConfigRev(),
			contentVersion,
			device: { width: FRAME_WIDTH, height: FRAME_HEIGHT, orientation: "landscape" },
			currentPage: deviceRec?.page ?? "home",
			desiredPage: deviceRec?.desiredPage
				? { page: deviceRec.desiredPage, seq: deviceRec.desiredPageSeq ?? 0 }
				: null,
			pages,
			// frame 下载基址(设备无关,共享渲染);客户端拼接 ?page=<id>
			frameBaseUrl: "/api/device/frame",
			// 远程刷新信号:seq 变化即触发一次同步;fullRefresh 另外要求全刷
			refreshSeq: deviceRec?.refreshSeq ?? 0,
			fullRefreshSeq: deviceRec?.fullRefreshSeq ?? 0,
			refresh: {
				pollSeconds: config.pollIntervalSec,
				forceFullAfter: 12,
				forceFullMinutes: Math.round(config.fullRefreshIntervalSec / 60),
			},
		});
	} catch (err) {
		next(err);
	}
});

// ---- Leaf Runtime 1.0:Heartbeat ----
// 设备上报运行时遥测(电量/充电/WiFi/页面版本/运行时长),驱动 Admin 在线状态
app.post("/api/device/:deviceId/heartbeat", express.json(), (req, res) => {
	const body = req.body ?? {};
	const pageVersions = {};
	for (const [k, v] of Object.entries(body.pageVersions ?? {})) {
		if (PAGES.includes(k) && Number.isFinite(Number(v))) pageVersions[k] = Number(v);
	}
	touchDevice(req.params.deviceId, {
		page: typeof body.currentPage === "string" ? body.currentPage : null,
		telemetry: {
			appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
			battery: Number.isFinite(Number(body.battery)) ? Number(body.battery) : null,
			charging: typeof body.charging === "boolean" ? body.charging : null,
			wifi: typeof body.wifi === "boolean" ? body.wifi : null,
			uptimeSec: Number.isFinite(Number(body.uptime)) ? Number(body.uptime) : null,
			pageVersions,
		},
	});
	res.json({ ok: true });
});

app.get("/api/device/:deviceId/status", (req, res) => {
	const version = currentVersion();
	const page = getPageParam(req.query);
	const config = getConfig();
	touchDevice(req.params.deviceId, { version, page });
	res.set("Cache-Control", "no-store");
	res.json({
		version,
		updatedAt: formatUpdatedAt(version),
		// M3:按 fullRefreshIntervalSec 周期性下发 full,其余 partial;
		// full 用于消残影,客户端尽力触发整屏刷新
		refresh:
			version % Math.max(1, Math.round(config.fullRefreshIntervalSec / 60)) === 0
				? "full"
				: "partial",
		page,
		pages: PAGES,
		// 轮询间隔由服务端统一控制,客户端钳制后应用
		pollIntervalSec: config.pollIntervalSec,
	});
});

// 旧 /api/device/:deviceId/frame 路由已移除:frame 内容与设备无关
// (顶/底栏不再渲染 deviceId),客户端统一走 manifest.frameBaseUrl
// 指向的共享路由 /api/device/frame。

// APK 分发(路线 B:设备无 adb 时的安装通道)
const PUBLIC_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"public",
);
const APK_PATH = path.join(PUBLIC_DIR, "LeafDashboard.apk");

// /download:APK 直链下载(显式指定 E-Ink 设备浏览器可识别的 MIME)
app.get("/download", (_req, res) => {
	res.setHeader("Content-Type", "application/vnd.android.package-archive");
	res.download(APK_PATH, "LeafDashboard.apk", (err) => {
		if (err && !res.headersSent) {
			res.status(err.status || 500).json({ error: "apk not found" });
		}
	});
});

// ---- Admin API(Milestone 5)----
// 内网信任环境,无鉴权(与 /download 一致);页面见 public/admin.html

app.get("/api/admin/devices", (_req, res) => {
	res.set("Cache-Control", "no-store");
	res.json({ devices: listDevices() });
});

app.get("/api/admin/config", (_req, res) => {
	res.json(getConfig());
});

app.post("/api/admin/config", express.json(), (req, res) => {
	// 只取白名单字段,防止任意键写盘
	const cfg = updateConfig(req.body ?? {});
	// 数据源可能变了,1s 后重拉快照,新源尽快上屏
	refreshSoon();
	res.json(cfg);
});

// ---- Leaf Runtime 1.0:远程控制 ----
// 远程切页:写入设备 desiredPage 指令,设备下次同步时应用
app.post("/api/admin/devices/:deviceId/desired-page", express.json(), (req, res) => {
	const page = req.body?.page;
	if (!PAGES.includes(page)) {
		res.status(400).json({ error: "unknown page" });
		return;
	}
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	const applied = setDesiredPage(deviceId, page);
	res.json({ ok: true, page: applied.page, seq: applied.seq });
});

// 远程刷新/全刷:递增信号 seq,设备下次轮询 manifest 时感知并立即同步
app.post("/api/admin/devices/:deviceId/refresh", express.json(), (req, res) => {
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	const full = Boolean(req.body?.full);
	const seq = bumpDeviceSignal(deviceId, full ? "fullRefresh" : "refresh");
	res.json({ ok: true, full, seq });
});

// 静态分发 public/(index.html 安装引导页;需在 404 兜底之前挂载)
app.use(express.static(PUBLIC_DIR));

// 404 兜底:统一 JSON,避免客户端解析到 HTML
app.use((_req, res) => {
	res.status(404).json({ error: "not found" });
});

// 错误兜底:渲染异常返回 500 JSON(配合 frame handler 的 try/next 生效)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
	console.error("[leaf5-dashboard] internal error:", err);
	res.status(500).json({ error: "internal error" });
});

const server = app.listen(PORT, () => {
	console.log(
		`[leaf5-dashboard] listening on http://0.0.0.0:${PORT} (frame ${FRAME_WIDTH}x${FRAME_HEIGHT})`,
	);
});

// 监听失败(如端口被占用)时输出友好中文提示后退出,不裸栈崩溃
server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(
			`[leaf5-dashboard] 启动失败:端口 ${PORT} 已被占用。请换一个端口启动,例如:PORT=39872 npm start`,
		);
	} else {
		console.error(`[leaf5-dashboard] 启动失败:${err.message}`);
	}
	process.exit(1);
});

// 模块加载完成,首次渲染落盘(此后由上面的周期定时器接管)
persistFrames().catch((err) => console.error("[leaf5-dashboard] frame persist:", err.message));
