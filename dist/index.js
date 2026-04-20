// pi-output-guard — universal tool_result token ceiling
// Extension for @mariozechner/pi-coding-agent
// Saves full output to /tmp and replaces in-flight tool_result with head+tail+notice.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const GUARD_DIR = join(AGENT_DIR, "pi-output-guard");
const CONFIG_PATH = join(AGENT_DIR, "pi-output-guard.json");
const STATS_PATH = join(GUARD_DIR, "stats.json");
const SPILL_DIR = "/tmp/pi-output-guard";

const DEFAULTS = {
	enabled: true,
	threshold: 10000, // tokens
	headTokens: 2000,
	tailTokens: 2000,
	perTool: {}, // { toolName: threshold }
};

function ensureDir(p) {
	try { mkdirSync(p, { recursive: true }); } catch {}
}

function loadConfig() {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return { ...DEFAULTS, ...raw, perTool: { ...(DEFAULTS.perTool), ...(raw.perTool || {}) } };
		}
	} catch {}
	return { ...DEFAULTS };
}

function saveConfig(cfg) {
	ensureDir(AGENT_DIR);
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadStats() {
	try {
		if (existsSync(STATS_PATH)) return JSON.parse(readFileSync(STATS_PATH, "utf8"));
	} catch {}
	return {};
}

function saveStats(stats) {
	ensureDir(GUARD_DIR);
	try { writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2)); } catch {}
}

// Token estimator — chars / 3.5 (conservative vs chars/4 which underestimated in FRI-H63).
// Tries to use pi-coding-agent's estimateTokens if available; otherwise falls back.
let externalEstimator = null;
async function tryLoadExternalEstimator() {
	if (externalEstimator !== null) return externalEstimator;
	try {
		const mod = await import("@mariozechner/pi-coding-agent");
		if (typeof mod.estimateTokens === "function") {
			externalEstimator = mod.estimateTokens;
			return externalEstimator;
		}
	} catch {}
	externalEstimator = false;
	return externalEstimator;
}

function countTokensText(text) {
	if (!text) return 0;
	return Math.ceil(text.length / 3.5);
}

function sumContentTokens(content) {
	let tokens = 0;
	for (const block of content || []) {
		if (block && block.type === "text" && typeof block.text === "string") {
			tokens += countTokensText(block.text);
		} else if (block && block.type === "image") {
			tokens += 1500; // flat estimate
		}
	}
	return tokens;
}

function concatTextContent(content) {
	const parts = [];
	for (const block of content || []) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function sliceByTokens(text, tokens, fromEnd = false) {
	// tokens → approx chars
	const chars = Math.max(0, Math.floor(tokens * 3.5));
	if (text.length <= chars) return text;
	if (fromEnd) return text.slice(text.length - chars);
	return text.slice(0, chars);
}

function sanitizeFilename(s) {
	return String(s || "tool").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
}

function spillPath(toolName, sessionId) {
	ensureDir(SPILL_DIR);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return join(SPILL_DIR, `${sanitizeFilename(toolName)}-${sanitizeFilename(sessionId)}-${ts}.txt`);
}

function makeNotice({ path, originalTokens, keptTokens, toolName, threshold }) {
	return [
		`[pi-output-guard] Tool result from \"${toolName}\" exceeded ${threshold} tokens.`,
		`Original size: ~${originalTokens} tokens. Showing head+tail (~${keptTokens} tokens).`,
		`Full output saved to: ${path}`,
		`To retrieve specific sections, call the \"output_read\" tool with:`,
		`  { "path": "${path}", "offset_lines": <start>, "limit_lines": <count> }`,
	].join("\n");
}

export default function piOutputGuard(pi) {
	ensureDir(AGENT_DIR);
	ensureDir(GUARD_DIR);
	ensureDir(SPILL_DIR);

	let config = loadConfig();
	let sessionStats = { truncated: 0, tokensSaved: 0, bytesSpilled: 0, byTool: {} };
	let sessionId = "unknown";

	tryLoadExternalEstimator();

	// ── tool_result hook ──
	pi.on("tool_result", async (event, _ctx) => {
		if (!config.enabled) return {};
		if (!event || !Array.isArray(event.content)) return {};

		const toolName = event.toolName || "unknown";

		// Never self-truncate (output_read is how the agent recovers).
		if (toolName === "output_read" || toolName === "output_guard_stats") return {};

		const threshold = Number(config.perTool?.[toolName] ?? config.threshold) || DEFAULTS.threshold;
		const totalTokens = sumContentTokens(event.content);
		if (totalTokens <= threshold) return {};

		const fullText = concatTextContent(event.content);
		const filePath = spillPath(toolName, sessionId);
		try { writeFileSync(filePath, fullText); } catch (e) {
			// If we can't spill, leave the result alone to avoid data loss.
			return {};
		}

		const headTok = Math.max(100, Number(config.headTokens) || DEFAULTS.headTokens);
		const tailTok = Math.max(100, Number(config.tailTokens) || DEFAULTS.tailTokens);

		const head = sliceByTokens(fullText, headTok, false);
		const tail = sliceByTokens(fullText, tailTok, true);
		const keptTokens = countTokensText(head) + countTokensText(tail);

		const notice = makeNotice({
			path: filePath,
			originalTokens: totalTokens,
			keptTokens,
			toolName,
			threshold,
		});

		const newContent = [
			{ type: "text", text: `${notice}\n\n--- HEAD (first ~${headTok} tokens) ---\n${head}` },
			{ type: "text", text: `\n--- TAIL (last ~${tailTok} tokens) ---\n${tail}` },
		];

		// Stats
		const saved = totalTokens - keptTokens;
		sessionStats.truncated += 1;
		sessionStats.tokensSaved += Math.max(0, saved);
		try { sessionStats.bytesSpilled += statSync(filePath).size; } catch {}
		const perTool = sessionStats.byTool[toolName] || { count: 0, tokensSaved: 0 };
		perTool.count += 1;
		perTool.tokensSaved += Math.max(0, saved);
		sessionStats.byTool[toolName] = perTool;
		const allStats = loadStats();
		allStats[sessionId] = sessionStats;
		saveStats(allStats);

		return { content: newContent };
	});

	// ── session_start: capture session id ──
	pi.on("session_start", async (event, _ctx) => {
		const id = event?.sessionId || event?.session?.id || event?.id;
		if (id) sessionId = String(id);
	});

	// ── output_read tool ──
	pi.registerTool({
		name: "output_read",
		label: "Output Read",
		description: "Read a section of a spilled tool output file that was truncated by pi-output-guard.",
		promptSnippet: "output_read: retrieve sections of truncated tool outputs saved by pi-output-guard.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path to the spilled file (from notice)." },
				offset_lines: { type: "number", description: "1-indexed line to start reading from. Default 1." },
				limit_lines: { type: "number", description: "Max number of lines to read. Default 500." },
			},
			required: ["path"],
		},
		async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = resolve(String(params.path || ""));
			if (!p.startsWith("/tmp/pi-output-guard/") && !p.startsWith(GUARD_DIR)) {
				return { content: [{ type: "text", text: `[output_read] refused: path must live under /tmp/pi-output-guard/` }], isError: true };
			}
			if (!existsSync(p)) {
				return { content: [{ type: "text", text: `[output_read] not found: ${p}` }], isError: true };
			}
			let text;
			try { text = readFileSync(p, "utf8"); } catch (e) {
				return { content: [{ type: "text", text: `[output_read] read error: ${e.message}` }], isError: true };
			}
			const lines = text.split("\n");
			const start = Math.max(1, Number(params.offset_lines) || 1);
			const limit = Math.max(1, Number(params.limit_lines) || 500);
			const slice = lines.slice(start - 1, start - 1 + limit).join("\n");
			const header = `[output_read] ${p} lines ${start}..${Math.min(lines.length, start + limit - 1)} of ${lines.length}`;
			return { content: [{ type: "text", text: `${header}\n${slice}` }], isError: false };
		},
	});

	// ── /output-guard commands ──
	function humanStats() {
		const t = sessionStats;
		const perTool = Object.entries(t.byTool || {})
			.map(([k, v]) => `  ${k}: ${v.count} truncation(s), ~${v.tokensSaved} tok saved`).join("\n") || "  (none)";
		return [
			`pi-output-guard — session ${sessionId}`,
			`  enabled: ${config.enabled}`,
			`  threshold: ${config.threshold} tokens (head=${config.headTokens}, tail=${config.tailTokens})`,
			`  truncations: ${t.truncated}`,
			`  tokens saved: ~${t.tokensSaved}`,
			`  bytes spilled: ${t.bytesSpilled}`,
			`per-tool:\n${perTool}`,
		].join("\n");
	}

	pi.registerCommand("output-guard", {
		description: "Control pi-output-guard (stats | threshold <N> | enable | disable | doctor)",
		handler: async (args, ctx) => {
			const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
			const sub = (tokens[0] || "stats").toLowerCase();
			const ui = ctx?.ui?.notify ? ctx.ui : { notify: (m) => console.log(m) };
			try {
				switch (sub) {
					case "stats": {
						ui.notify(humanStats(), "info");
						return;
					}
					case "threshold": {
						const n = Number(tokens[1]);
						if (!Number.isFinite(n) || n < 500) { ui.notify("usage: /output-guard threshold <N>=500", "warning"); return; }
						config.threshold = Math.floor(n);
						saveConfig(config);
						ui.notify(`pi-output-guard: threshold set to ${config.threshold} tokens`, "info");
						return;
					}
					case "enable": {
						config.enabled = true; saveConfig(config);
						ui.notify("pi-output-guard: enabled", "info"); return;
					}
					case "disable": {
						config.enabled = false; saveConfig(config);
						ui.notify("pi-output-guard: disabled (tool_result will pass through)", "warning"); return;
					}
					case "doctor": {
						const lines = [];
						lines.push(`config: ${CONFIG_PATH} ${existsSync(CONFIG_PATH) ? "(ok)" : "(defaults in use)"}`);
						lines.push(`spill dir: ${SPILL_DIR} ${existsSync(SPILL_DIR) ? "(ok)" : "(missing)"}`);
						lines.push(`stats: ${STATS_PATH} ${existsSync(STATS_PATH) ? "(ok)" : "(empty)"}`);
						lines.push(`estimator: ${externalEstimator ? "pi-coding-agent" : "chars/3.5 fallback"}`);
						lines.push(`enabled: ${config.enabled}, threshold: ${config.threshold}`);
						ui.notify(lines.join("\n"), "info"); return;
					}
					default: {
						ui.notify("usage: /output-guard [stats|threshold <N>|enable|disable|doctor]", "warning"); return;
					}
				}
			} catch (e) {
				ui.notify(`output-guard error: ${e.message}`, "error");
			}
		},
	});
}
