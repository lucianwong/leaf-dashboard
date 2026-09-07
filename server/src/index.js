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
import {
	startBackgroundRefresh,
	getSnapshotData,
	refreshSoon,
} from "./datasources.js";

// 轻量 .env 加载:凭据(API key)只进环境变量,不进 config.json。
// 不覆盖已有的同名 env(显式 export 优先);文件不存在时静默跳过。
// 必须在 initStore/startBackgroundRefresh 之前执行,否则首次快照
// 拉取时 ZAI_API_KEY/KIMI_API_KEY 尚未就位(AI 源会白失败一轮)
const ENV_FILE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	".env",
);
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

import {
	initCommandStore,
	createCommand,
	listPending,
	listRecent,
	markSent,
	ackCommand,
	expireSweep,
	COMMAND_TYPES,
} from "./commands.js";

initStore();
initCommandStore();
startBackgroundRefresh();
// 与快照同节奏周期渲染落盘(首次在模块尾部定义后立即执行)
setInterval(
	() =>
		persistFrames().catch((err) =>
			console.error("[leaf5-dashboard] frame persist:", err.message),
		),
	60_000,
).unref();

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
// 各页 PNG 由后台周期渲染落盘(storage/frames/<page>.png)。
// 响应方式(0.5.1 Bug#home-mismatch 修复):动态路由直接回内存渲染缓存条目,
// 与 manifest 同取 renderPageCached,字节级同源零竞态;磁盘文件仅作同步产物
// (persistFrameIfNeeded 保持新鲜,供 Admin 预览等消费)。必须在 /:deviceId 路由之前注册。
const FRAMES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"storage",
	"frames",
);

// GET /api/device/frame/<page>.png:从内存渲染缓存出图(与 manifest 的 sha256 同源)
app.get("/api/device/frame/:file", async (req, res, next) => {
	try {
		const page = String(req.params.file).replace(/\.png$/, "");
		if (!PAGES.includes(page)) return next(); // 未知页落到后面的静态兑底
		const entry = await renderPageCached(page);
		persistFrameIfNeeded(page, entry); // 磁盘文件与内存保持同步
		res.set("Content-Type", "image/png");
		res.set("Cache-Control", "no-store");
		res.set("X-Frame-Sha256", entry.sha256);
		res.send(entry.buffer);
	} catch (err) {
		next(err);
	}
});

// 静态兑底:未知页/旧残留文件的磁盘直出(新页面不会走到)
app.use("/api/device/frame", express.static(FRAMES_DIR, { maxAge: 0 }));

// 周期渲染全部页面并原子落盘(sha 变了才重写,避免无谓磁盘写)
const lastWrittenSha = new Map();
// 单页按需落盘:内存渲染缓存 sha 与磁盘不一致时立即原子写入。
// manifest 下发前对每页调用,保证「manifest 的 sha256 == 随后 GET /frame/<page>.png
// 字节的 sha256」同源,消除 60s 周期落盘与 manifest 之间的滞后窗口
// (home 页含时钟每分钟变,滞后窗口内 App 必然 sha mismatch discard)。
// 写盘为同步 fs 调用,Node 单线程内不会交错;写入内容恒为同一 sha 的 buffer,并发无害。
function persistFrameIfNeeded(page, entry) {
	if (lastWrittenSha.get(page) === entry.sha256) return;
	lastWrittenSha.set(page, entry.sha256);
	const target = path.join(FRAMES_DIR, `${page}.png`);
	fs.mkdirSync(FRAMES_DIR, { recursive: true });
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, entry.buffer);
	fs.renameSync(tmp, target);
}

async function persistFrames() {
	for (const page of PAGES) {
		persistFrameIfNeeded(page, await renderPageCached(page));
	}
	// 清理已下线页面的残留文件(页面模型收口后 servers/agents.png 等)
	try {
		for (const f of fs.readdirSync(FRAMES_DIR)) {
			if (f.endsWith(".png")) {
				const page = f.replace(/\.png$/, "");
				if (!PAGES.includes(page))
					fs.rmSync(path.join(FRAMES_DIR, f), { force: true });
			}
		}
	} catch {
		// 清理失败不影响主流程
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
	const buffer = await renderFrame({
		page,
		version: minute,
		deviceId: "shared",
	});
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
			// 先落盘再下发:manifest 的 sha256 与磁盘文件字节严格同源(Bug#home-mismatch 修复)
			persistFrameIfNeeded(page, entry);
			contentVersion = Math.max(contentVersion, entry.version);
			pages.push({
				id: page,
				version: entry.version,
				sha256: entry.sha256,
			});
		}

		const deviceRec = listDevices().find((d) => d.deviceId === deviceId);

		// 0.5.0 Command V1:过期清理 → 取待下发命令 → 标记 sent。
		// 旧客户端(0.4.x)会忽略未知 commands 字段,legacy 字段保留兼容
		expireSweep();
		const pendingCommands = listPending(deviceId);
		for (const cmd of pendingCommands) markSent(cmd);

		res.set("Cache-Control", "no-store");
		res.json({
			configVersion: getConfigRev(),
			contentVersion,
			device: {
				width: FRAME_WIDTH,
				height: FRAME_HEIGHT,
				orientation: "landscape",
			},
			currentPage: deviceRec?.page ?? "home",
			desiredPage: deviceRec?.desiredPage
				? { page: deviceRec.desiredPage, seq: deviceRec.desiredPageSeq ?? 0 }
				: null,
			pages,
			commands: pendingCommands.map((c) => ({
				id: c.id,
				seq: c.seq,
				type: c.type,
				payload: c.payload ?? {},
				createdAt: c.createdAt,
				expiresAt: c.expiresAt,
			})),
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
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	const pageVersions = {};
	for (const [k, v] of Object.entries(body.pageVersions ?? {})) {
		if (PAGES.includes(k) && Number.isFinite(Number(v)))
			pageVersions[k] = Number(v);
	}
	// 当前页白名单校验(设备上报数据不可直接落盘)
	const currentPage = PAGES.includes(body.currentPage)
		? body.currentPage
		: null;
	// Leaf Runtime 1.1 诊断/E-Ink 指标:逐字段类型校验后透传给 storage 白名单
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
	const str = (v) => (typeof v === "string" ? v : null);
	// capabilities:字符串数组(如 eink-native-v1),元素字符串化并限制数量防膨胀
	const strArr = (v) =>
		Array.isArray(v) ? v.map((x) => String(x)).slice(0, 32) : null;
	touchDevice(deviceId, {
		page: currentPage,
		telemetry: {
			appVersion: str(body.appVersion),
			battery: num(body.battery),
			charging: typeof body.charging === "boolean" ? body.charging : null,
			wifi: typeof body.wifi === "boolean" ? body.wifi : null,
			uptimeSec: num(body.uptime),
			pageVersions,
			androidVersion: str(body.androidVersion),
			buildCommit: str(body.buildCommit),
			deviceModel: str(body.deviceModel),
			lastSyncAt: num(body.lastSyncAt),
			lastSyncStatus: str(body.lastSyncStatus),
			lastError: str(body.lastError),
			frameCacheBytes: num(body.frameCacheBytes),
			syncAttemptCount: num(body.syncAttemptCount),
			syncSuccessCount: num(body.syncSuccessCount),
			syncFailCount: num(body.syncFailCount),
			frameDownloadCount: num(body.frameDownloadCount),
			frameDownloadFailCount: num(body.frameDownloadFailCount),
			partialRefreshCount: num(body.partialRefreshCount),
			partialRefreshTotal: num(body.partialRefreshTotal),
			partialSinceFull: num(body.partialSinceFull),
			fullRefreshCount: num(body.fullRefreshCount),
			lastFullRefreshAt: num(body.lastFullRefreshAt),
			crashCount: num(body.crashCount),
			safeMode: typeof body.safeMode === "boolean" ? body.safeMode : null,
			safeModeUntil: num(body.safeModeUntil),
			einkController: str(body.einkController),
			einkAvailable:
				typeof body.einkAvailable === "boolean" ? body.einkAvailable : null,
			einkMode: str(body.einkMode),
			capabilities: strArr(body.capabilities),
			lastRefreshStrategy: str(body.lastRefreshStrategy),
		},
	});
	res.json({ ok: true });
});

app.get("/api/device/:deviceId/status", (req, res) => {
	// deviceId 白名单化(与其他端点一致)
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	const version = currentVersion();
	const page = getPageParam(req.query);
	const config = getConfig();
	touchDevice(deviceId, { version, page });
	res.set("Cache-Control", "no-store");
	res.json({
		version,
		updatedAt: formatUpdatedAt(version),
		// M3:按 fullRefreshIntervalSec 周期性下发 full,其余 partial;
		// full 用于消残影,客户端尽力触发整屏刷新
		refresh:
			version % Math.max(1, Math.round(config.fullRefreshIntervalSec / 60)) ===
			0
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
app.post(
	"/api/admin/devices/:deviceId/desired-page",
	express.json(),
	(req, res) => {
		const page = req.body?.page;
		if (!PAGES.includes(page)) {
			res.status(400).json({ error: "unknown page" });
			return;
		}
		const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
		const applied = setDesiredPage(deviceId, page);
		res.json({ ok: true, page: applied.page, seq: applied.seq });
	},
);

// 远程刷新/全刷:递增信号 seq,设备下次轮询 manifest 时感知并立即同步
app.post("/api/admin/devices/:deviceId/refresh", express.json(), (req, res) => {
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	const full = Boolean(req.body?.full);
	const seq = bumpDeviceSignal(deviceId, full ? "fullRefresh" : "refresh");
	res.json({ ok: true, full, seq });
});

// ---- 0.5.0 Command V1 ----
// (原 COMMAND_PAGE_ALIASES 常量从未被引用,已移除;如需 page.switch 别名可从 git 历史找回)

// Admin 创建命令
app.post(
	"/api/admin/devices/:deviceId/commands",
	express.json(),
	(req, res) => {
		const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
		const type = req.body?.type;
		if (!COMMAND_TYPES.includes(type)) {
			res.status(400).json({ error: "unknown command type" });
			return;
		}
		let payload = {};
		if (type === "page.switch") {
			const page = req.body?.payload?.page ?? req.body?.page;
			if (!PAGES.includes(page)) {
				res.status(400).json({ error: "unknown page" });
				return;
			}
			payload = { page };
		}
		const cmd = createCommand(deviceId, type, payload);
		res.json({ id: cmd.id, seq: cmd.seq, status: cmd.status });
	},
);

// Admin 命令历史(最近 8 条,createdAt 倒序)
app.get("/api/admin/devices/:deviceId/commands", (req, res) => {
	const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
	res.set("Cache-Control", "no-store");
	res.json({ commands: listRecent(deviceId, 8) });
});

// 设备 ACK:received(收到)/succeeded(执行成功)/failed(执行失败,带 error)
app.post(
	"/api/device/:deviceId/commands/:commandId/ack",
	express.json(),
	(req, res) => {
		const deviceId = String(req.params.deviceId).replace(/[^\w-]/g, "");
		const commandId = String(req.params.commandId).replace(/[^\w-]/g, "");
		const status = req.body?.status;
		if (!["received", "succeeded", "failed"].includes(status)) {
			res.status(400).json({ error: "invalid ack status" });
			return;
		}
		const cmd = ackCommand(
			deviceId,
			commandId,
			status,
			typeof req.body?.error === "string" ? req.body.error : null,
			req.body?.result ?? null,
		);
		if (!cmd) {
			res.status(404).json({ error: "command not found" });
			return;
		}
		res.json({ ok: true, status: cmd.status });
	},
);

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
persistFrames().catch((err) =>
	console.error("[leaf5-dashboard] frame persist:", err.message),
);
