// Command Store(Leaf Dashboard 0.5.0 Sprint A):
// 统一远程命令模型,替代散落的 desiredPage/refreshSeq/fullRefreshSeq。
//
// 状态机:PENDING → SENT → RECEIVED → SUCCEEDED / FAILED;超时 → EXPIRED。
// 可靠性:At-least-once 下发 + 设备端幂等执行(CommandLedger)。
// 持久化:storage/commands.json,原子写;进程重启命令不丢。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS_FILE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"storage",
	"commands.json",
);

export const COMMAND_TYPES = [
	"page.switch",
	"device.refresh",
	"device.full_refresh",
	"sync.restart",
];

const COMMAND_TTL_MS = 24 * 3600_000; // 离线设备恢复后命令仍可执行, TTL 给足 24h
const MAX_PENDING_PER_DEVICE = 10;
const MAX_HISTORY = 50;

/** @type {Map<string, object>} id -> command */
const commands = new Map();
/** @type {Map<string, number>} deviceId -> 最近 seq */
const seqByDevice = new Map();

function load() {
	try {
		const data = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
		for (const cmd of data.commands ?? []) commands.set(cmd.id, cmd);
		for (const [d, s] of Object.entries(data.seqs ?? {})) seqByDevice.set(d, s);
	} catch {
		// 首次启动无文件
	}
}

function persist() {
	fs.mkdirSync(path.dirname(COMMANDS_FILE), { recursive: true });
	const tmp = `${COMMANDS_FILE}.tmp`;
	fs.writeFileSync(
		tmp,
		JSON.stringify(
			{
				commands: [...commands.values()],
				seqs: Object.fromEntries(seqByDevice),
			},
			null,
			2,
		),
	);
	fs.renameSync(tmp, COMMANDS_FILE);
}

// 命令可靠性要求"设备离线期间命令不能消失":创建/ACK 立即落盘
// (低频事件,写盘成本可忽略),不用节流——节流窗口内进程被杀会丢命令
function persistNow() {
	try {
		persist();
	} catch (e) {
		console.error("[commands] persist failed:", e.message);
	}
}

export function initCommandStore() {
	load();
}

function makeId() {
	return `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 创建命令(seq 按设备单调递增);返回命令对象 */
export function createCommand(deviceId, type, payload = {}) {
	const seq = (seqByDevice.get(deviceId) ?? 0) + 1;
	seqByDevice.set(deviceId, seq);
	const cmd = {
		id: makeId(),
		deviceId,
		seq,
		type,
		payload,
		status: "pending",
		createdAt: Date.now(),
		expiresAt: Date.now() + COMMAND_TTL_MS,
		error: null,
		result: null,
	};
	commands.set(cmd.id, cmd);
	persistNow();
	trimDeviceHistory(deviceId);
	return cmd;
}

/** 单设备历史上限:保留最近 MAX_HISTORY 条(终态优先清理) */
function trimDeviceHistory(deviceId) {
	const own = [...commands.values()]
		.filter((c) => c.deviceId === deviceId)
		.sort((a, b) => b.createdAt - a.createdAt);
	if (own.length <= MAX_HISTORY) return;
	for (const cmd of own.slice(MAX_HISTORY)) {
		if (isTerminal(cmd.status)) commands.delete(cmd.id);
	}
}

function isTerminal(status) {
	return status === "succeeded" || status === "failed" || status === "expired";
}

/** 过期清理:pending/sent 超时 → expired(每次 manifest 拉取时顺带执行) */
export function expireSweep() {
	const now = Date.now();
	for (const cmd of commands.values()) {
		if (
			!isTerminal(cmd.status) &&
			cmd.expiresAt &&
			cmd.expiresAt < now
		) {
			cmd.status = "expired";
			persistNow();
		}
	}
}

/** 待下发命令(不含已终态/已过期),按 seq 升序,限量 max */
export function listPending(deviceId, max = MAX_PENDING_PER_DEVICE) {
	return [...commands.values()]
		.filter(
			(c) =>
				c.deviceId === deviceId &&
				!isTerminal(c.status) &&
				(c.expiresAt ?? Date.now()) > Date.now(),
		)
		.sort((a, b) => a.seq - b.seq)
		.slice(0, max);
}

/** manifest 携带后标记 sent(仅首次记录 sentAt) */
export function markSent(cmd) {
	if (cmd.status === "pending") {
		cmd.status = "sent";
		cmd.sentAt = Date.now();
		persistNow();
	}
}

/**
 * 设备 ACK:
 *  - received:pending/sent → received
 *  - succeeded/failed:任意非终态 → 终态(重复 ACK 幂等返回既有终态)
 * 未知 commandId 返回 null。
 */
export function ackCommand(deviceId, commandId, status, error = null, result = null) {
	const cmd = commands.get(commandId);
	if (!cmd || cmd.deviceId !== deviceId) return null;
	if (isTerminal(cmd.status)) {
		// 幂等:重复 ACK(如设备重发)直接返回既有终态,不重复写盘
		return cmd;
	}
	if (status === "received") {
		cmd.status = "received";
		cmd.receivedAt = Date.now();
	} else if (status === "succeeded" || status === "failed") {
		cmd.status = status;
		cmd.completedAt = Date.now();
		cmd.error = error ?? null;
		cmd.result = result ?? null;
	} else {
		return null; // 非法状态
	}
	persistNow();
	return cmd;
}

/** Admin 历史:最近 limit 条,createdAt 倒序 */
export function listRecent(deviceId, limit = 8) {
	return [...commands.values()]
		.filter((c) => c.deviceId === deviceId)
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, limit);
}
