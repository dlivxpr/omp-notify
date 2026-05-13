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

// ============================================================================
// Configuration
// ============================================================================

interface NotifyConfig {
	enabled: boolean;
	minIntervalMs: number;
	maxPerSession: number;
	enableFocusCheck: boolean;
	title: string;
}

const CONFIG: NotifyConfig = {
	enabled: true,
	minIntervalMs: 30_000,
	maxPerSession: 20,
	enableFocusCheck: true,
	title: "OMP",
};

// ============================================================================
// State
// ============================================================================

interface NotifyState {
	lastNotifyTime: number;
	notifyCount: number;
	sessionFile: string;
}

const state: NotifyState = {
	lastNotifyTime: 0,
	notifyCount: 0,
	sessionFile: "",
};

// ============================================================================
// Summary Generation
// ============================================================================

function generateSummary(event: TurnEndEvent): string {
	const { toolResults, message } = event;

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

// ============================================================================
// Windows Focus Detection
// ============================================================================

async function isWindowFocused(pi: ExtensionAPI): Promise<boolean> {
	const myPid = process.pid;

	const script = `
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

function Get-AncestorPids([int]$pid) {
    $ancestors = @($pid)
    $current = $pid
    $visited = @($pid)
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
$intersection.Count -gt 0
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
			.replace(/'/g, "&apos;");
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

	try {
		await pi.exec("powershell", ["-NoProfile", "-Command", script], {
			timeout: 10000,
		});
	} catch (err) {
		pi.logger.warn(`[omp-notify] Toast notification failed: ${err}`);
	}
}

// ============================================================================
// Main Extension
// ============================================================================

export default function ompNotify(pi: ExtensionAPI) {
	pi.setLabel("OMP Notify");

	function shouldNotify(bypassThrottle = false): boolean {
		if (!CONFIG.enabled) {
			pi.logger.debug("[omp-notify] Disabled, skipping");
			return false;
		}
		if (state.notifyCount >= CONFIG.maxPerSession) {
			pi.logger.debug("[omp-notify] Max notifications reached for this session");
			return false;
		}
		if (!bypassThrottle) {
			const now = Date.now();
			if (now - state.lastNotifyTime < CONFIG.minIntervalMs) {
				pi.logger.debug("[omp-notify] Too soon since last notification");
				return false;
			}
		}
		return true;
	}

	async function maybeNotify(
		title: string,
		body: string,
		options?: { bypassThrottle?: boolean },
	): Promise<void> {
		if (!shouldNotify(options?.bypassThrottle)) return;

		if (CONFIG.enableFocusCheck) {
			try {
				const focused = await isWindowFocused(pi);
				if (focused) {
					pi.logger.debug("[omp-notify] Window is focused, skipping notification");
					return;
				}
			} catch {
				// Continue to notify on focus check failure
			}
		}

		await sendWindowsNotification(pi, title, body);

		state.lastNotifyTime = Date.now();
		state.notifyCount++;
		pi.logger.info(
			`[omp-notify] Notification sent (${state.notifyCount}/${CONFIG.maxPerSession})`,
		);
	}

	// Reset state on session start
	pi.on("session_start", async (_event, ctx) => {
		state.sessionFile = ctx.sessionManager.getSessionFile() || "";
		state.notifyCount = 0;
		state.lastNotifyTime = 0;
		pi.logger.info(`[omp-notify] Session started: ${state.sessionFile || "<new>"}`);
	});

	// Main trigger: turn ended
	pi.on("turn_end", async (event) => {
		const summary = generateSummary(event as TurnEndEvent);
		await maybeNotify(CONFIG.title, summary);
	});

	// Fallback trigger: agent ended
	pi.on("agent_end", async (_event) => {
		pi.logger.info("[omp-notify] agent_end event received");
		const summary = generateAgentEndSummary();
		await maybeNotify(CONFIG.title, summary, { bypassThrottle: true });
	});

	pi.logger.info("[omp-notify] Extension loaded");
}
