/**
 * OMP Windows Notify Extension
 *
 * Sends Windows system notifications when OMP completes work and the user
 * is not focused on the OMP terminal window.
 */

// ============================================================================
// Inline type declarations (OMP runtime provides these at load time)
// ============================================================================

interface ExtensionAPI {
	setLabel(label: string): void;
	on(
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void,
	): void;
	exec(
		command: string,
		args: string[],
		options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
	): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	logger: {
		info(msg: string): void;
		warn(msg: string): void;
		debug(msg: string): void;
	};
}

interface ExtensionContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	hasUI: boolean;
	cwd: string;
	sessionManager: {
		getSessionFile(): string | undefined;
	};
	isIdle(): boolean;
	abort(): void;
}

interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: {
		role: string;
		content?: Array<{ type: string; text?: string }>;
	};
	toolResults: Array<{
		toolName: string;
		isError: boolean;
		content: Array<{ type: string; text?: string }>;
	}>;
}

interface AgentEndEvent {
	type: "agent_end";
	messages: unknown[];
}

interface SessionShutdownEvent {
	type: "session_shutdown";
}

// ============================================================================
// Configuration
// ============================================================================

interface NotifyConfig {
	enabled: boolean;
	minIntervalMs: number;
	maxPerSession: number;
	enableFocusCheck: boolean;
	focusCheckStrict: boolean;
	title: string;
}

function loadConfig(): NotifyConfig {
	return {
		enabled: process.env.OMP_NOTIFY_ENABLED !== "false",
		minIntervalMs: parseInt(process.env.OMP_NOTIFY_MIN_INTERVAL || "30000", 10),
		maxPerSession: parseInt(process.env.OMP_NOTIFY_MAX_PER_SESSION || "20", 10),
		enableFocusCheck: process.env.OMP_NOTIFY_FOCUS_CHECK !== "false",
		focusCheckStrict: process.env.OMP_NOTIFY_FOCUS_CHECK_STRICT === "true",
		title: process.env.OMP_NOTIFY_TITLE || "OMP",
	};
}


const CONFIG: NotifyConfig = loadConfig();

// ============================================================================
// State
// ============================================================================

interface NotifyState {
	lastNotifyTime: number;
	notifyCount: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	lastSummary: string;
	lastSummaryTime: number;
	lastTurnSummary: string;
	lastTurnSummaryTime: number;
	lastEndSummary: string;
	lastEndSummaryTime: number;
	isNotifying: boolean;
}

const state: NotifyState = {
	lastNotifyTime: 0,
	notifyCount: 0,
	retryTimer: null,
	lastSummary: "",
	lastSummaryTime: 0,
	lastTurnSummary: "",
	lastTurnSummaryTime: 0,
	lastEndSummary: "",
	lastEndSummaryTime: 0,
	isNotifying: false,
};

// ============================================================================
// Summary Generation
// ============================================================================

function generateSummary(event: TurnEndEvent): string {

	const toolResults = event.toolResults || [];
	const message = event.message || { role: "assistant", content: [] };

	const totalTools = toolResults.length;
	const errorTools = toolResults.filter((t) => t.isError).length;
	const successTools = totalTools - errorTools;

	const toolNames = [...new Set(toolResults.map((t) => t.toolName))];

	let assistantText = "";
	if (message.content) {
		const textContent = message.content.find((c) => c.type === "text");
		if (textContent?.text) {
			assistantText = textContent.text.slice(0, 80);
			if (textContent.text.length > 80) assistantText += "...";
		}
	}

	if (totalTools === 0) {
		return assistantText || "任务已完成，等待输入";
	}

	let summary = "";
	if (errorTools > 0) {
		summary += `${errorTools}/${totalTools} 个工具执行出错`;
	} else {
		summary += `${successTools} 个工具执行完成`;
	}

	if (toolNames.length > 0) {
		const names = toolNames.slice(0, 3).join(", ");
		summary += ` (${names}${toolNames.length > 3 ? " 等" : ""})`;
	}

	if (assistantText) {
		summary += ` · ${assistantText}`;
	}

	return summary;
}

function generateAgentEndSummary(): string {
	return "所有任务已完成，等待你的输入";
}

function generateSessionShutdownSummary(): string {
	return "OMP 会话已结束";
}

// ============================================================================
// Windows Focus Detection
// ============================================================================

async function isWindowFocused(pi: ExtensionAPI, strict: boolean): Promise<boolean> {
	const myPid = process.pid;

	const script = strict
		? `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static uint GetForegroundPid() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }
}
"@

$fgPid = [int][WinFocus]::GetForegroundPid()
$myPid = ${myPid}
$fgPid -eq $myPid
`.trim()
		: `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static uint GetForegroundPid() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }
}
"@

function Get-AncestorPids([int]$TargetPid) {
	$ancestors = @($TargetPid)
	$current = $TargetPid
	$visited = @($TargetPid)
    while ($true) {
        try {
            $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
            if (-not $proc -or -not $proc.Parent) { break }
            $parentId = $proc.Parent.Id
            if ($visited -contains $parentId) { break }
            $ancestors += $parentId
            $visited += $parentId
            $current = $parentId
        } catch { break }
    }
    return $ancestors
}

$fgPid = [int][WinFocus]::GetForegroundPid()
$myPid = ${myPid}

$myAncestors = Get-AncestorPids $myPid
$fgAncestors = Get-AncestorPids $fgPid

$intersection = $myAncestors | Where-Object { $fgAncestors -contains $_ }
($intersection | Measure-Object).Count -gt 0
`.trim();

	try {
		const result = await pi.exec("powershell", ["-NoProfile", "-Command", script], {
			timeout: 5000,
		});
		return result.stdout.trim().toLowerCase() === "true";
	} catch {
		return false;
	}
}

// ============================================================================
// Windows Notification
// ============================================================================

async function sendWindowsNotification(
	pi: ExtensionAPI,
	title: string,
	body: string,
): Promise<void> {
	// Escape XML special characters for Toast XML
	function xmlEscape(str: string): string {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")

			.replace(/'/g, "&apos;")
			.replace(/\r?\n/g, " ");
	}

	const safeTitle = xmlEscape(title);
	const safeBody = xmlEscape(body);

	const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data, ContentType = WindowsRuntime] | Out-Null

$title = '${safeTitle}'
$body = '${safeBody}'
$template = '<toast><visual><binding template="ToastText02"><text id="1">{0}</text><text id="2">{1}</text></binding></visual></toast>'
$xmlStr = $template -f $title, $body
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml($xmlStr)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OMP").Show($toast)
`.trim();


	await pi.exec("powershell", ["-NoProfile", "-Command", script], {
		timeout: 10000,
	});
}

// ============================================================================
// Main Extension
// ============================================================================

export default function ompNotify(pi: ExtensionAPI) {
	pi.setLabel("OMP Notify");

	function shouldNotify(bypassThrottle = false): boolean {
		if (!CONFIG.enabled) {
			pi.logger.info("[omp-notify] Disabled, skipping");
			return false;
		}
		if (state.notifyCount >= CONFIG.maxPerSession) {
			pi.logger.info("[omp-notify] Max notifications reached for this session");
			return false;
		}
		if (!bypassThrottle) {
			const now = Date.now();
			if (now - state.lastNotifyTime < CONFIG.minIntervalMs) {
				pi.logger.info("[omp-notify] Too soon since last notification");
				return false;
			}
		}
		return true;
	}


	async function maybeNotify(
		title: string,
		body: string,
		options?: { bypassThrottle?: boolean; dedupType?: "turn" | "end" },
	): Promise<{ sent: boolean; reason?: string }> {
		if (state.isNotifying) {
			pi.logger.info("[omp-notify] Notification already in progress, skipping");
			return { sent: false, reason: "busy" };
		}

		if (!shouldNotify(options?.bypassThrottle)) {
			return { sent: false, reason: "throttle" };
		}

		state.isNotifying = true;
		try {
			// Deduplicate: skip if same summary within 10s
			const now = Date.now();
			const dedupType = options?.dedupType ?? "turn";
			if (dedupType === "turn") {
				if (body === state.lastTurnSummary && now - state.lastTurnSummaryTime < 10_000) {
					pi.logger.info("[omp-notify] Duplicate turn summary, skipping");
					return { sent: false, reason: "duplicate" };
				}
			} else {
				if (body === state.lastEndSummary && now - state.lastEndSummaryTime < 10_000) {
					pi.logger.info("[omp-notify] Duplicate end summary, skipping");
					return { sent: false, reason: "duplicate" };
				}
			}

			if (CONFIG.enableFocusCheck) {
				try {
					const focused = await isWindowFocused(pi, CONFIG.focusCheckStrict);
					if (focused) {
						pi.logger.info("[omp-notify] Window is focused, skipping notification");
						return { sent: false, reason: "focused" };
					}
				} catch (err) {
					pi.logger.warn(`[omp-notify] Focus check failed: ${err}`);
					// Continue to notify on focus check failure
				}
			}

			// Optimistic state update
			const prevTime = state.lastNotifyTime;
			const prevCount = state.notifyCount;
			state.lastNotifyTime = now;
			state.notifyCount++;
			state.lastSummary = body;
			state.lastSummaryTime = now;
			if (dedupType === "turn") {
				state.lastTurnSummary = body;
				state.lastTurnSummaryTime = now;
			} else {
				state.lastEndSummary = body;
				state.lastEndSummaryTime = now;
			}

			try {
				await sendWindowsNotification(pi, title, body);
			} catch (err) {
				// Rollback on failure
				state.lastNotifyTime = prevTime;
				state.notifyCount = prevCount;
				state.lastSummary = "";
				state.lastSummaryTime = 0;
				if (dedupType === "turn") {
					state.lastTurnSummary = "";
					state.lastTurnSummaryTime = 0;
				} else {
					state.lastEndSummary = "";
					state.lastEndSummaryTime = 0;
				}
				pi.logger.warn(`[omp-notify] Toast notification failed (API may be unavailable): ${err}`);
				return { sent: false, reason: "send_failed" };
			}

			pi.logger.info(
				`[omp-notify] Notification sent (${state.notifyCount}/${CONFIG.maxPerSession})`,
			);
			return { sent: true };
		} finally {
			state.isNotifying = false;
		}
	}
	// Reset state on session start

	pi.on("session_start", async () => {
		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = null;
		}
		state.notifyCount = 0;
		state.lastNotifyTime = 0;
		state.lastSummary = "";
		state.lastSummaryTime = 0;
		state.lastTurnSummary = "";
		state.lastTurnSummaryTime = 0;
		state.lastEndSummary = "";
		state.lastEndSummaryTime = 0;
		state.isNotifying = false;
		pi.logger.info("[omp-notify] Session started, state reset");
	});

	// Main trigger: turn ended
	pi.on("turn_end", async (event) => {
		const summary = generateSummary(event as TurnEndEvent);
		await maybeNotify(CONFIG.title, summary, { dedupType: "turn" });
	});

	// Fallback trigger: agent ended
	pi.on("agent_end", async (_event) => {
		pi.logger.info("[omp-notify] agent_end event received");
		const summary = generateAgentEndSummary();
		const result = await maybeNotify(CONFIG.title, summary, { bypassThrottle: true, dedupType: "end" });

		if (!result.sent && (result.reason === "focused" || result.reason === "send_failed")) {
			pi.logger.info("[omp-notify] Retrying notification in 5s after " + result.reason);
			state.retryTimer = setTimeout(async () => {
				pi.logger.info("[omp-notify] Retry notification after delay");
				await maybeNotify(CONFIG.title, summary, { bypassThrottle: true, dedupType: "end" });
				state.retryTimer = null;
			}, 5000);
		}
	});

	// Session shutdown trigger
	pi.on("session_shutdown", async (_event) => {
		pi.logger.info("[omp-notify] session_shutdown event received");
		const summary = generateSessionShutdownSummary();
		const result = await maybeNotify(CONFIG.title, summary, { bypassThrottle: true, dedupType: "end" });

		if (!result.sent && (result.reason === "focused" || result.reason === "send_failed")) {
			pi.logger.info("[omp-notify] Retrying notification in 5s after " + result.reason);
			state.retryTimer = setTimeout(async () => {
				pi.logger.info("[omp-notify] Retry notification after delay");
				await maybeNotify(CONFIG.title, summary, { bypassThrottle: true, dedupType: "end" });
				state.retryTimer = null;
			}, 5000);
		}
	});

	pi.logger.info("[omp-notify] Extension loaded");
}
