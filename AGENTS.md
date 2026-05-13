# Repository Guidelines

## Project Overview

`omp-notify` is an [OMP](https://github.com/oh-my-pi) extension that sends native Windows toast notifications when an agent finishes work and the user is not focused on the OMP terminal window. It is a single-file TypeScript plugin with no runtime dependencies.

## Architecture & Data Flow

The extension follows an **event-driven plugin pattern** with a single default export.

```
session_start  → reset state (notifyCount, timers, lastSummary)
     │
     ▼
turn_end       → generateSummary(event) → maybeNotify(title, body)
     │                                          │
     ▼                                          ▼
agent_end      → generateAgentEndSummary()  → focus check (Win32/PowerShell)
                                                  │
                                                  ▼
                                           throttle / dedup / max-per-session
                                                  │
                                                  ▼
                                           sendWindowsNotification (PowerShell + Windows.UI.Notifications)
```

Key design points:
- **Lifecycle events** (`session_start`, `turn_end`, `agent_end`) drive all behavior.
- **Focus detection** walks the process ancestor tree via PowerShell + `user32.dll` to determine if the OMP terminal is the foreground window.
- **Toast delivery** invokes PowerShell which loads the Windows Runtime `ToastNotificationManager`.
- **Optimistic state updates** with rollback on failure (see `maybeNotify`).
- **Retry timer** on `agent_end` if focus check suppresses the notification; retries once after 5 seconds.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Single source file (`index.ts`) containing the entire extension |
| Root | Config, documentation, and license |

## Development Commands

```bash
# Type-check only (no emit)
bun run check
# or directly:
tsc --noEmit

# Install dependencies
bun install
```

There is **no build step**, **no test runner**, and **no linter** configured in this repo.

## Code Conventions & Common Patterns

### Extension Structure
- **Default export function** pattern: `export default function ompNotify(pi: ExtensionAPI)`.
- Register handlers via `pi.on(eventName, handler)`.
- Inline interfaces for OMP runtime types (the host provides these at load time).

### Configuration
- Loaded from **environment variables** with sensible defaults:
  ```ts
  enabled: process.env.OMP_NOTIFY_ENABLED !== "false"
  minIntervalMs: parseInt(process.env.OMP_NOTIFY_MIN_INTERVAL || "30000", 10)
  ```
- Keep the `loadConfig()` pattern; do not hardcode values outside of defaults.

### State Management
- **Module-level mutable state** stored in a single `const state: NotifyState` object.
- Reset on `session_start`; increment counts and timestamps on successful send.
- Always clear `retryTimer` before resetting state to avoid leaks.

### Error Handling
- Wrap PowerShell calls in `try/catch`; on failure, **rollback optimistic state** and log via `pi.logger.warn`.
- Focus check failures are non-fatal: log and continue to notify.

### PowerShell Script Injection
- Toast content is passed into PowerShell template strings. **Always escape XML** via `xmlEscape()` before interpolation to prevent broken toast XML or injection.
- Use `pi.exec("powershell", ["-NoProfile", "-Command", script], { timeout })` for all external calls.

### Async Patterns
- Event handlers are `async` and awaited by the host.
- Use `setTimeout` for the focus retry; store the handle on `state.retryTimer`.

## Important Files

| File | Role |
|------|------|
| `src/index.ts` | **Entry point and entire extension logic** — config, state, summary generation, focus detection, toast delivery, event handlers |
| `package.json` | Manifest; `main` points to `src/index.ts`; single script `check` runs `tsc --noEmit` |
| `tsconfig.json` | Strict TypeScript, ES2022/ESNext, bundler resolution, `noEmit`, includes `src/**/*.ts` |
| `README.md` | User-facing docs with environment variable table |
| `LICENSE` | MIT License |

## Runtime/Tooling Preferences

| Tool | Preference |
|------|------------|
| Package manager | **Bun** (`bun.lock` present; `bun.lock` is gitignored) |
| TypeScript | `^5.4.0`, strict mode enabled |
| Runtime target | ES2022 / ESNext modules |
| Host | OMP (Oh My Pi) harness — loads the TS source directly; no bundler in this repo |
| OS requirement | **Windows 10/11** (PowerShell + .NET + Win32 APIs required) |

There is no bundler, no formatter, and no linting toolchain. Changes should pass `tsc --noEmit`.

## Testing & QA

- **No test framework** is configured.
- **No tests exist** in the repo.
- The only quality gate is `bun run check` (TypeScript type-checking).
- If adding tests, prefer a lightweight runner compatible with Bun (e.g., `bun:test`) since Bun is the established package manager.
