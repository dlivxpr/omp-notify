# omp-notify

Windows system notifications for [OMP](https://github.com/oh-my-pi) when tasks complete.

When you're working in another window, `omp-notify` pops a native Windows toast notification so you never miss when your agent finishes work.

---

## Features

- **Native Windows toast notifications** — Uses the Windows.UI.Notifications API for proper system-level toasts with notification center history
- **Smart focus detection** — Only notifies when the OMP terminal is not the active foreground window, avoiding redundant interruptions
- **Automatic deduplication** — Skips duplicate summaries within 10 seconds
- **Rate limiting** — Configurable minimum interval and per-session maximum to prevent notification spam
- **Retry on focus** — If the agent ends while the window is focused, retries once after 5 seconds in case you switch away
- **Rich summaries** — Shows which tools ran, error counts, and a preview of the assistant's response

## Installation

Place this extension in your OMP extensions directory. OMP will auto-load it on startup.

## Configuration

All settings are controlled via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OMP_NOTIFY_ENABLED` | `true` | Set to `false` to disable notifications entirely |
| `OMP_NOTIFY_MIN_INTERVAL` | `30000` | Minimum milliseconds between notifications |
| `OMP_NOTIFY_MAX_PER_SESSION` | `20` | Maximum notifications per OMP session |
| `OMP_NOTIFY_FOCUS_CHECK` | `true` | Set to `false` to always notify regardless of focus |
| `OMP_NOTIFY_TITLE` | `OMP` | Title shown in the toast notification |

## Requirements

- Windows 10/11
- PowerShell with .NET runtime (available by default on modern Windows)

## License

[MIT](./LICENSE)
