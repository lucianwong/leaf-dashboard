// Frame 渲染器:输出 1680x1264 纯黑白(白底黑字)PNG,供 E-Ink 屏显示。
//
// E-Ink 设计原则:
//  - 只用 #000000 / #FFFFFF 两色,无灰阶、无渐变、无动画
//  - 线条加粗(>=4px),300PPI 下细线会发虚
//  - 大字号、大留白、清晰框线分区

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { getSnapshotData } from "./datasources.js";

export const FRAME_WIDTH = 1680;
export const FRAME_HEIGHT = 1264;

// 页面清单(M4 多页面):客户端据此预取与本地缓存,顺序即翻页顺序。
// calendar 为真实月历(纯服务端可算),ai/servers/agents 暂为占位页,
// 数据源接入后逐页替换实现。
export const PAGES = ["home", "calendar", "ai", "servers", "agents"];

const BLACK = "#000000";
const WHITE = "#FFFFFF";

// ---------------------------------------------------------------------------
// 字体初始化
//
// 策略(按任务书要求:系统可用字体优先;中文缺失时回退英文):
//  1. @napi-rs/canvas 会自动加载操作系统字体目录(macOS/Windows/部分 Linux),
//     先在 GlobalFonts.families 里探测常见中文字体家族名。
//  2. 若探测不到,再尝试从一组常见路径显式注册(macOS 的 PingFang/Hiragino、
//     Linux 的 Noto/WenQuanYi 等,alpine 容器默认无字体)。
//  3. 若仍失败(hasCJK = false),渲染文本走英文回退(标签函数 t(zh, en)),
//     避免中文渲染成豆腐块。Docker 镜像中额外通过 apk 安装 font-noto 保证
//     西文字体可用,中文则按上述逻辑自动回退英文。
// ---------------------------------------------------------------------------

const CJK_FAMILY_PROBES = [
	"PingFang SC",
	"Hiragino Sans GB",
	"Noto Sans CJK SC",
	"Noto Sans SC",
	"WenQuanYi Zen Hei",
	"WenQuanYi Micro Hei",
	"Source Han Sans SC",
];

// [文件路径, 注册用的家族名]
const FONT_FILE_PROBES = [
	// macOS 中文字体(ttc,capable skia 取第一个 face)
	["/System/Library/Fonts/PingFang.ttc", "DashCJK"],
	["/System/Library/Fonts/Hiragino Sans GB.ttc", "DashCJK"],
	// Linux 常见中文字体
	["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "DashCJK"],
	["/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "DashCJK"],
];

const LATIN_FILE_PROBES = [
	// macOS 西文
	["/System/Library/Fonts/Supplemental/Arial.ttf", "DashSans"],
	["/System/Library/Fonts/Helvetica.ttc", "DashSans"],
	// Linux 常见西文(alpine apk add font-noto 的安装路径)
	["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DashSans"],
	["/usr/share/fonts/noto/NotoSans-Regular.ttf", "DashSans"],
];

function firstExistingFamily(names) {
	try {
		const families = GlobalFonts.families.map((f) => f.family);
		for (const name of names) {
			if (families.includes(name)) return name;
		}
	} catch {
		// families 列表不可用时忽略,走文件注册路径
	}
	return null;
}

function registerFirstExisting(probes) {
	for (const [path, family] of probes) {
		try {
			if (GlobalFonts.registerFromPath(path, family)) return family;
		} catch {
			// 注册失败(文件不存在/格式不支持)则尝试下一个候选
		}
	}
	return null;
}

function initFonts() {
	// 中文字体:先探测系统家族,再尝试显式注册
	let cjk = firstExistingFamily(CJK_FAMILY_PROBES);
	if (!cjk) cjk = registerFirstExisting(FONT_FILE_PROBES);

	// 西文字体:同上;全部失败时留 null,交给 skia 内置默认字体兜底
	let latin = firstExistingFamily([
		"Arial",
		"Helvetica",
		"DejaVu Sans",
		"Noto Sans",
	]);
	if (!latin) latin = registerFirstExisting(LATIN_FILE_PROBES);

	return {
		hasCJK: Boolean(cjk),
		cjkFamily: cjk,
		latinFamily: latin,
	};
}

const fonts = initFonts();

// 文案选择:有中文字体用中文,否则回退英文(代码层面避免豆腐块)
const t = (zh, en) => (fonts.hasCJK ? zh : en);

// font 简写:加粗时依赖 skia 合成粗体(ttf 只有 Regular 也可用)
function fontCss(px, { bold = false, cjk = false } = {}) {
	const family = (cjk && fonts.cjkFamily) || fonts.latinFamily || "sans-serif";
	const name = family.includes(" ") ? `"${family}"` : family;
	return `${bold ? "bold " : ""}${px}px ${name}`;
}

// ---------------------------------------------------------------------------
// 版本号:时间驱动,每分钟 +1,与大时钟 HH:MM 内容变化节奏一致
// ---------------------------------------------------------------------------

export function currentVersion(now = Date.now()) {
	return Math.floor(now / 60_000);
}

// 内容变化的时刻(本分钟起点),格式化为带本地时区的 ISO 字符串
// 例:2026-09-06T12:34:00+08:00
export function formatUpdatedAt(version) {
	const d = new Date(version * 60_000);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const offsetMin = -d.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
	const om = pad(Math.abs(offsetMin) % 60);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${oh}:${om}`
	);
}

// ---------------------------------------------------------------------------
// Frame 渲染
// ---------------------------------------------------------------------------

const WEEK_ZH = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六",
];
const WEEK_EN = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const MONTH_EN = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function pad2(n) {
	return String(n).padStart(2, "0");
}

// 居中画一行文字(textAlign=center, baseline=middle)
function drawCenteredText(ctx, text, cx, cy, css) {
	ctx.font = css;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, cx, cy);
}

// 左对齐 / 右对齐单行文字(baseline=middle)
function drawText(ctx, text, x, y, css, align = "left") {
	ctx.font = css;
	ctx.textAlign = align;
	ctx.textBaseline = "middle";
	ctx.fillText(text, x, y);
}

function drawFrameBorder(ctx, x, y, w, h, lineWidth) {
	ctx.lineWidth = lineWidth;
	ctx.strokeRect(x, y, w, h);
}

function drawHLine(ctx, y, x0, x1, lineWidth) {
	ctx.lineWidth = lineWidth;
	ctx.beginPath();
	ctx.moveTo(x0, y);
	ctx.lineTo(x1, y);
	ctx.stroke();
}

/**
 * 渲染一帧 Dashboard。
 * @param {object} opts
 * @param {string} opts.page    页面名(PAGES 之一)
 * @param {number} opts.version 当前版本号(分钟数)
 * @param {string} opts.deviceId 设备 ID(footer 显示)
 * @param {object} [opts.data]  数据源数据(fetchAllData 结果,单项可为 null)
 * @param {number} [opts.now]   渲染时刻(默认当前时间)
 * @returns {Buffer} PNG 数据
 */
export function renderFrame({ page, version, deviceId, data, now = Date.now() }) {
	// 数据默认取后台刷新快照(内存读,请求路径零网络);调用方也可显式传入覆盖
	const frameData = data ?? getSnapshotData();
	const d = new Date(now);

	const canvas = createCanvas(FRAME_WIDTH, FRAME_HEIGHT);
	const ctx = canvas.getContext("2d");

	// 白底
	ctx.fillStyle = WHITE;
	ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
	ctx.fillStyle = BLACK;
	ctx.strokeStyle = BLACK;

	const M = 48; // 页面外边距

	// 按页面分发内容(占满整个画布;设备/版本等调试信息不占屏)
	if (page === "calendar") {
		renderCalendarPage(ctx, d, frameData.events);
	} else if (page === "home") {
		renderHomePage(ctx, d, frameData);
	} else if (page === "servers") {
		renderStatusPage(ctx, frameData.servers, t("服务器", "SERVERS"));
	} else if (page === "agents") {
		renderStatusPage(ctx, frameData.agents, t("智能体", "AGENTS"));
	} else if (page === "ai") {
		renderAiPage(ctx, frameData.aiUsage);
	} else {
		renderPlaceholderPage(ctx, page);
	}

	return canvas.encode("png");
}

// ---- Home 页:大时钟 + 日期 + 天气/日程/待办三框(占满画布) ----
function renderHomePage(ctx, d, data) {
	const M = 48;
	const hh = pad2(d.getHours());
	const mm = pad2(d.getMinutes());
	drawCenteredText(
		ctx,
		`${hh}:${mm}`,
		FRAME_WIDTH / 2,
		470,
		fontCss(340, { bold: true }),
	);

	const dateText = fonts.hasCJK
		? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_ZH[d.getDay()]}`
		: `${WEEK_EN[d.getDay()]}, ${MONTH_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
	drawCenteredText(
		ctx,
		dateText,
		FRAME_WIDTH / 2,
		690,
		fontCss(72, { cjk: true }),
	);

	// ---- 中部分隔线 + 天气/日程/待办三框(数据缺失回退占位) ----
	drawHLine(ctx, 780, M, FRAME_WIDTH - M, 4);

	const boxTop = 820;
	const boxBottom = FRAME_HEIGHT - M; // 底边直接贴页面外边距
	const boxH = boxBottom - boxTop;
	const gap = 36;
	const boxW = Math.floor((FRAME_WIDTH - 2 * M - 2 * gap) / 3);

	const widgets = [
		renderWeatherWidget(ctx, M, boxTop, boxW, boxH, data.weather),
		renderEventsWidget(ctx, M + boxW + gap, boxTop, boxW, boxH, data.events),
		renderTodoWidget(ctx, M + 2 * (boxW + gap), boxTop, boxW, boxH, data.todos),
	];
	widgets.forEach((fn) => fn());
}

// 三框通用外框+标题,返回内容绘制回调(统一在标题下方起画)
function renderWeatherWidget(ctx, x, y, w, h, weather) {
	drawFrameBorder(ctx, x, y, w, h, 5);
	drawText(ctx, t("天气", "WEATHER"), x + 32, y + 56, fontCss(56, { bold: true, cjk: true }));
	return () => {
		const cx = x + w / 2;
		if (!weather) {
			drawCenteredText(ctx, t("未配置数据源", "NO SOURCE"), cx, y + h / 2 + 20, fontCss(44, { cjk: true }));
			return;
		}
		drawCenteredText(ctx, `${weather.temp}°`, cx, y + 180, fontCss(130, { bold: true }));
		drawCenteredText(ctx, weather.cond, cx, y + 310, fontCss(48, { cjk: true }));
		drawCenteredText(
			ctx,
			t(`最高 ${weather.high}° 最低 ${weather.low}°`, `H ${weather.high}° L ${weather.low}°`),
			cx,
			y + h - 40,
			fontCss(40, { cjk: true }),
		);
	};
}

function renderEventsWidget(ctx, x, y, w, h, events) {
	drawFrameBorder(ctx, x, y, w, h, 5);
	drawText(ctx, t("日程", "EVENTS"), x + 32, y + 56, fontCss(56, { bold: true, cjk: true }));
	return () => {
		if (!events || !events.length) {
			drawCenteredText(
				ctx,
				t("暂无日程", "NO EVENTS"),
				x + w / 2,
				y + h / 2 + 20,
				fontCss(44, { cjk: true }),
			);
			return;
		}
		// 最多 5 条:时间(月/日 时:分)+ 摘要(截断)
		events.slice(0, 5).forEach((ev, i) => {
			const ey = y + 160 + i * 58;
			const when = `${ev.start.getMonth() + 1}/${ev.start.getDate()} ${pad2(ev.start.getHours())}:${pad2(ev.start.getMinutes())}`;
			drawText(ctx, when, x + 32, ey, fontCss(36, { bold: true }));
			drawText(ctx, ev.summary.slice(0, 12), x + 190, ey, fontCss(36, { cjk: true }));
		});
	};
}

function renderTodoWidget(ctx, x, y, w, h, todos) {
	drawFrameBorder(ctx, x, y, w, h, 5);
	const open = (todos ?? []).filter((it) => !it.done).length;
	drawText(ctx, t(`待办 (${open})`, `TODO (${open})`), x + 32, y + 56, fontCss(56, { bold: true, cjk: true }));
	return () => {
		if (!todos || !todos.length) {
			drawCenteredText(ctx, t("暂无待办", "EMPTY"), x + w / 2, y + h / 2 + 20, fontCss(44, { cjk: true }));
			return;
		}
		// 未完成优先,画 5 条;完成项加删除线前缀(√)
		const shown = [...todos].sort((a, b) => Number(a.done) - Number(b.done)).slice(0, 5);
		shown.forEach((it, i) => {
			const ty = y + 160 + i * 58;
			const mark = it.done ? "√" : "□";
			const text = it.done ? t(`(已完成) ${it.text}`, `done: ${it.text}`) : it.text.slice(0, 11);
			drawText(ctx, `${mark} ${text}`, x + 32, ty, fontCss(38, { cjk: true }));
		});
	};
}

// ---- Calendar 页:当月真实月历(今日反白高亮)+ 未来 7 天日程 ----
function renderCalendarPage(ctx, d, events) {
	const M = 48;

	const year = d.getFullYear();
	const month = d.getMonth();
	const today = d.getDate();

	// 月标题:左侧年月
	const monthText = fonts.hasCJK
		? `${year}年${month + 1}月`
		: `${MONTH_EN[month]} ${year}`;
	drawText(ctx, monthText, M, 160, fontCss(96, { bold: true, cjk: true }));

	// 网格区域:标题下方,底部留 190px 给日程列表
	const gridTop = 250;
	const gridBottom = 1020;
	const cellW = (FRAME_WIDTH - 2 * M) / 7;
	const cellH = (gridBottom - gridTop) / 7; // 首行星期表头 + 6 行日期

	// 星期表头
	const weekNames = fonts.hasCJK
		? ["日", "一", "二", "三", "四", "五", "六"]
		: WEEK_EN;
	weekNames.forEach((name, i) => {
		drawCenteredText(
			ctx,
			name,
			M + cellW * (i + 0.5),
			gridTop + cellH * 0.5,
			fontCss(48, { bold: true, cjk: true }),
		);
	});
	drawHLine(ctx, gridTop + cellH, M, FRAME_WIDTH - M, 4);

	// 日期格子:当月 1 号的星期偏移决定首行起点
	const firstDay = new Date(year, month, 1).getDay();
	const daysInMonth = new Date(year, month + 1, 0).getDate();
	for (let day = 1; day <= daysInMonth; day++) {
		const slot = firstDay + day - 1;
		const col = slot % 7;
		const row = Math.floor(slot / 7);
		if (row >= 6) break; // 网格只留 6 行,理论上月份最多占 6 行,防御性截断
		const cx = M + cellW * (col + 0.5);
		const cy = gridTop + cellH * (row + 1.5);

		if (day === today) {
			// 今日:反白块(黑底白字),E-Ink 下最醒目
			const r = Math.min(cellW, cellH) * 0.42;
			ctx.fillStyle = BLACK;
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = WHITE;
			drawCenteredText(ctx, String(day), cx, cy, fontCss(52, { bold: true }));
			ctx.fillStyle = BLACK;
		} else {
			drawCenteredText(ctx, String(day), cx, cy, fontCss(52));
		}
	}

	// 竖向分隔线(7 列):只画日期区
	ctx.lineWidth = 2;
	for (let i = 1; i < 7; i++) {
		const x = M + cellW * i;
		ctx.beginPath();
		ctx.moveTo(x, gridTop + cellH);
		ctx.lineTo(x, gridBottom);
		ctx.stroke();
	}

	// ---- 底部:未来 7 天日程(两条并排) ----
	drawHLine(ctx, 1060, M, FRAME_WIDTH - M, 4);
	drawText(ctx, t("近 7 天日程", "NEXT 7 DAYS"), M, 1110, fontCss(44, { bold: true, cjk: true }));
	if (events?.length) {
		events.slice(0, 2).forEach((ev, i) => {
			const when = `${ev.start.getMonth() + 1}/${ev.start.getDate()} ${pad2(ev.start.getHours())}:${pad2(ev.start.getMinutes())}`;
			const text = `${when}  ${ev.summary.slice(0, 16)}`;
			drawText(
				ctx,
				text,
				M + 320 + i * ((FRAME_WIDTH - 2 * M - 320) / 2),
				1110,
				fontCss(40, { cjk: true }),
			);
		});
	} else {
		drawText(ctx, t("暂无日程", "NO EVENTS"), M + 320, 1110, fontCss(40, { cjk: true }));
	}
}

// ---- 占位页(PAGES 中尚未实现布局的页面兜底):大标题 + 待接入提示 ----
function renderPlaceholderPage(ctx, page) {
	const M = 48;
	drawCenteredText(
		ctx,
		page.toUpperCase(),
		FRAME_WIDTH / 2,
		560,
		fontCss(200, { bold: true }),
	);
	drawHLine(ctx, 700, 400, FRAME_WIDTH - 400, 4);
	drawCenteredText(
		ctx,
		t("待接入数据源", "NO DATA SOURCE YET"),
		FRAME_WIDTH / 2,
		830,
		fontCss(64, { cjk: true }),
	);
	// 页面序号提示,便于真机翻页验证
	const idx = PAGES.indexOf(page) + 1;
	drawCenteredText(
		ctx,
		t(`第 ${idx} / ${PAGES.length} 页`, `PAGE ${idx} / ${PAGES.length}`),
		FRAME_WIDTH / 2,
		1020,
		fontCss(44, { cjk: true }),
	);
}

// ---- 服务器/Agent 页:探活列表(在线●+延迟 / 离线○) ----
function renderStatusPage(ctx, probes, title) {
	const M = 48;
	drawText(ctx, title, M, 150, fontCss(88, { bold: true, cjk: true }));
	drawHLine(ctx, 230, M, FRAME_WIDTH - M, 4);

	if (!probes || !probes.length) {
		drawCenteredText(
			ctx,
			t("未配置探活目标,请在 Admin 页添加", "NO TARGETS - ADD IN ADMIN"),
			FRAME_WIDTH / 2,
			660,
			fontCss(48, { cjk: true }),
		);
		return;
	}

	const rowTop = 280;
	const rowBottom = 1120;
	const maxRows = 6;
	const rowH = (rowBottom - rowTop) / maxRows;
	probes.slice(0, maxRows).forEach((p, i) => {
		const y = rowTop + i * rowH + rowH / 2;
		// 状态圆点:实心=在线,空心=离线
		ctx.beginPath();
		ctx.arc(M + 30, y, 22, 0, Math.PI * 2);
		if (p.up) {
			ctx.fill();
		} else {
			ctx.lineWidth = 6;
			ctx.stroke();
		}
		drawText(ctx, p.name, M + 90, y, fontCss(52, { bold: true, cjk: true }));
		const status = p.up ? t(`在线 · ${p.ms}ms`, `UP · ${p.ms}ms`) : t("离线", "DOWN");
		drawText(
			ctx,
			status,
			FRAME_WIDTH - M,
			y,
			fontCss(44, { cjk: true }),
			"right",
		);
		if (i < Math.min(probes.length, maxRows) - 1) {
			drawHLine(ctx, rowTop + (i + 1) * rowH, M, FRAME_WIDTH - M, 2);
		}
	});

	const upCount = probes.filter((p) => p.up).length;
	drawText(
		ctx,
		t(`${upCount} / ${probes.length} 在线`, `${upCount} / ${probes.length} UP`),
		M,
		1160,
		fontCss(40, { cjk: true }),
	);
}

// ---- AI 页:用量(配额进度条,E-Ink 黑白条纹)+ 文本摘要 ----
function renderAiPage(ctx, usage) {
	const M = 48;
	drawText(ctx, t("AI 用量", "AI USAGE"), M, 150, fontCss(88, { bold: true, cjk: true }));
	drawHLine(ctx, 230, M, FRAME_WIDTH - M, 4);

	if (!usage) {
		drawCenteredText(
			ctx,
			t("未配置用量端点,请在 Admin 页填写", "NO ENDPOINT - CONFIGURE IN ADMIN"),
			FRAME_WIDTH / 2,
			660,
			fontCss(48, { cjk: true }),
		);
		return;
	}

	drawCenteredText(ctx, usage.label, FRAME_WIDTH / 2, 400, fontCss(64, { cjk: true }));

	if (usage.text) {
		drawCenteredText(ctx, usage.text.slice(0, 24), FRAME_WIDTH / 2, 600, fontCss(88, { bold: true, cjk: true }));
	} else if (usage.used != null && usage.quota) {
		// 大数字 + 黑白进度条(条纹填充,E-Ink 友好)
		drawCenteredText(
			ctx,
			`${usage.used} / ${usage.quota}`,
			FRAME_WIDTH / 2,
			620,
			fontCss(120, { bold: true }),
		);
		const barX = 240;
		const barW = FRAME_WIDTH - 2 * 240;
		const ratio = Math.min(1, usage.used / usage.quota);
		const barY = 760;
		const barH = 80;
		ctx.lineWidth = 6;
		ctx.strokeRect(barX, barY, barW, barH);
		// 条纹填充:每 24px 一根竖线,黑底比例按 ratio
		const fillW = Math.round(barW * ratio);
		ctx.save();
		ctx.beginPath();
		ctx.rect(barX, barY, fillW, barH);
		ctx.clip();
		for (let x = barX; x < barX + fillW; x += 24) {
			ctx.fillRect(x, barY, 12, barH);
		}
		ctx.restore();
		// 百分比角标
		drawCenteredText(ctx, `${Math.round(ratio * 100)}%`, FRAME_WIDTH / 2, 940, fontCss(64, { bold: true }));
	} else if (usage.used != null) {
		drawCenteredText(ctx, String(usage.used), FRAME_WIDTH / 2, 620, fontCss(120, { bold: true }));
	}
}
