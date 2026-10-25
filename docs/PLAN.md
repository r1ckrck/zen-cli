# zen-cli plan

## Goal

A light command-line tool that lets Claude Code understand and drive the Zen browser, and tells Claude how to use it. Works on any Mac or Windows PC. Built for low CPU, low memory and low token use.

## Architecture

- **CLI, not MCP.** No context cost until a command runs, and usable by hand from a terminal.
- **One Node file, no dependencies.** Requires Node 22+ (built-in WebSocket). Platform-specific code (Zen location, quit/relaunch, helper socket) lives in one section.
- **Protocol: WebDriver BiDi** over Zen's remote-debugging port, bound to `127.0.0.1`.
- **Helper process.** Firefox allows one BiDi session at a time, and tab ids and element refs are only valid within a session. Closing a socket does not end a session, so a killed command would leave a zombie session that blocks Zen until restart. The first `zen-cli` command starts a background helper from the same file. The helper holds the session, tab ids and refs; each command talks to it over a Unix socket (macOS) or named pipe (Windows). The helper exits after 10 idle minutes.
- **Zombie protection.** Only the helper ever owns the session; `zen-cli` commands never do, so killing a command is harmless. The helper ends the session on every exit path it can catch (normal exit, idle exit, SIGINT, SIGTERM, uncaught errors). A zombie left by a force-killed helper can only be cleared by restarting Zen; `start` and `status` detect it ("Maximum number of active sessions") and offer the restart.
- **System access by default.** `start` launches Zen with `--remote-allow-system-access`. The helper reads Zen's live state from the browser window (chrome scope): every tab across Spaces (from `tab.tabbrowser-tab` elements, since `gBrowser.tabs` covers only the active Space), each tab's Space, folder, pinned and Essential flags, unloaded tabs, the selected tab and the active Space. Unloaded pinned tabs can be activated.
- **Tabs in inactive Spaces** are invisible to BiDi (Zen keeps their browsers out of `gBrowser.browsers`). They're listed, but reading or acting on one needs `go`, which switches Spaces.
- **Dialogs.** With system access, open dialogs are read from each tab's dialog box before every command and after every action, and answered through the dialog's own buttons. This covers types BiDi can't see or handle (`alertCheck`, `confirmCheck`).
- **Plain-BiDi fallback.** If Zen runs with the port but without system access, commands still work with plain-BiDi limits: only loaded tabs, active tab by heuristic, no Spaces in `tabs`, `layout` from the session file, no `upload` or `open --space`, and repeated dialogs can block a page.
- **Session file as offline fallback.** `zen-sessions.jsonlz4` in the profile (mozlz4-compressed JSON) gives the layout while Zen is closed. It can lag behind Zen (sync can add tabs at launch), so live state wins whenever Zen runs. The reader ignores unknown fields so Zen updates don't break it.
- **Element refs** live as long as the helper's session. Refs from before a helper restart fail cleanly and ask for a fresh read.
- **Reused from [beSaif/zenpilot](https://github.com/beSaif/zenpilot) (MIT, notice kept in the source):** page walker, element-prepare and input scripts, value setter for date/color/range inputs, scroll fallback, quit/relaunch handling, and its workarounds for a covered Zen window (background tab create, activate timeout).

## Portability

| Area | macOS | Windows |
|---|---|---|
| Zen app | `/Applications`, `~/Applications`, then Spotlight by bundle id (`app.zen-browser.zen`) | `Zen Browser\zen.exe` under Program Files, `%LOCALAPPDATA%\Programs` and `%LOCALAPPDATA%`, then the App Paths registry key |
| Profiles root | `~/Library/Application Support/zen` | `%APPDATA%\zen` |
| Default profile | Read from `installs.ini`, then `profiles.ini` | Same |
| Zen running? | `lsof` on the profile's `.parentlock` | `parent.lock` held open, then `tasklist` |
| Helper socket | Unix socket in the OS temp dir | Named pipe `\\.\pipe\zen-cli-<user>-<port>` |
| Graceful quit | `NSRunningApplication.terminate` (same as Cmd+Q) | `taskkill /IM zen.exe` without `/F` (asks Zen's windows to close) |
| Relaunch | `open -na <app> --args --profile <path> --remote-debugging-port <port> --remote-allow-system-access` | `zen.exe` with the same arguments, detached |
| Temp files and screenshots | OS temp dir | OS temp dir |

- **Overrides:** `--profile <name|path>`, `--port <n>`, and environment variables `ZEN_CLI_APP`, `ZEN_CLI_PROFILE`, `ZEN_CLI_PORT`.
- **Default port 9333**, not 9222, so it doesn't collide with Chrome's usual debugging port.
- No hard-coded user names, home paths or profile folders anywhere.

## Commands

### Understanding

| Command | Output |
|---|---|
| `zen-cli tabs [--space <name>] [--all]` | Tabs with id (`t1`…), title, URL, selected marker, Space/folder, loaded or not. Defaults to the active Space plus Essentials; `--all` lists every Space. |
| `zen-cli layout` | Spaces, Essentials, folders, pinned tabs: live from Zen when running, from the session file when closed |
| `zen-cli read [tab]` | **Compact by default:** indented outline of headings, landmarks and interactive elements with refs (`e1`…) and state (checked, expanded, disabled, value). Covers iframes, open shadow DOM and cursor-pointer controls; masks passwords. |
| `zen-cli read --full` | Compact outline plus page text, capped at about 12,000 characters (text dropped first when over). Compact is capped at 5,400 characters with link targets shortened; truncation says how many lines were shown. |
| `zen-cli read eN` | Only the subtree under one element. Sections (header, nav, main, form, fieldset, dialog and similar) carry refs so they can be read alone. |
| `zen-cli read --find "text"` | Only matching elements, with their parent sections |
| `zen-cli text [tab]` | Main readable text (`main`, single `article`, or `body`), length-capped |
| `zen-cli shot [tab] [eN]` | JPEG screenshot of the page or one element, saved to the temp dir; prints the path |

### Interacting

| Command | Action |
|---|---|
| `zen-cli open <url> [--new] [--space <name>]` | Navigate the current tab, or a new tab when `--new` is given or the current tab is pinned. If the URL matches a pinned tab, switches to that tab instead of duplicating it. `--space` adds a background tab to that Space without switching the user's view; acting on it needs `go`. |
| `zen-cli go <tab>` / `zen-cli close <tab> [--force]` | Switch to a tab, changing Space and loading it if needed / close a tab. Pinned tabs and Essentials need `--force`. |
| `zen-cli back` / `zen-cli forward` / `zen-cli reload` | History and reload |
| `zen-cli click eN` | Trusted mouse click after scrolling into view |
| `zen-cli type eN "text" [--enter]` | Trusted typing; direct value set for date, time, color and range inputs |
| `zen-cli select eN "option"` | Choose a dropdown option |
| `zen-cli upload eN <file...>` | Set files on a file input. Needs system access; enables `dom.file.createInChild` only for the call. |
| `zen-cli press <key>` | Key or chord, e.g. `Enter`, `Meta+L` |
| `zen-cli scroll down\|up\|left\|right [px]` | Wheel scroll, with a JS fallback when the wheel is ignored |
| `zen-cli dialog accept\|dismiss ["text"]` | Answer an alert, confirm, prompt or leave-page dialog |
| `zen-cli js "code" [eN]` | Run JavaScript in the page and print the result; with `eN`, `code` is a function taking that element |

- Every action prints a one-line outcome: navigation and final URL, new tab id, the element that covered the click target, or an open dialog.
- Any command run while a dialog is open reports the dialog and its text instead of hanging.
- `--read` on any action appends the compact outline of the result, saving a separate read.
- Refs never reuse numbers, so an old ref fails cleanly instead of hitting a different element.

### Self-description, setup and control

| Command | Purpose |
|---|---|
| `zen-cli help` | One line per command |
| `zen-cli guide` | How Claude should use the tool: the read → act → check loop, refs, `--read`, dialogs, when to screenshot (rarely), error recovery. Max 800 tokens. |
| `zen-cli setup` | Adds `remote.prefs.recommended = false` to the chosen profile's `user.js`, marks Zen's welcome screen as seen if it isn't (pages have no size until then), and installs the Claude Code skill into `~/.claude/skills/zen-cli/` (or `$CLAUDE_CONFIG_DIR/skills/zen-cli/`). Safe to run again. |
| `zen-cli start [--restart]` | Ensure Zen runs with the port and system access. Refuses until `setup` has added the safety pref. If Zen is open without the port or without system access, or a zombie session blocks it, it asks in a terminal; without one it prints what a restart costs and the `--restart` command to run after asking the user. Quits gracefully and relaunches; tabs restore. |
| `zen-cli status` | Zen found, profile, safety pref, skill, port, system access, zombie session, Safe Browsing and popup blocker state, helper pid and memory |

- Errors are one line and say what to do next.
- The skill only says to run `zen-cli guide`, so instructions live in the tool. Skill description max 50 tokens.

## Install

- `npm install -g git+https://github.com/r1ckrck/zen-cli.git`, which provides the `zen-cli` command. No packages are pulled in.
- Then `zen-cli setup` once per machine.

## Launch and safety

- Zen opens normally from the Dock or Start menu, without the port. Claude runs `zen-cli start` when it needs the browser; the port stays on until Zen quits. A restart keeps tabs, Spaces and logins but loses unsaved page state (half-filled forms, media position).
- `remote.prefs.recommended = false` stops the remote agent from rewriting about 40 prefs. Without it, Safe Browsing and the popup blocker are off for as long as remote control runs (verified in step 0).
- On macOS, uploading from Documents, Desktop or Downloads makes macOS ask whether Zen may access that folder; Zen blocks until the user answers.
- System access lets any local program that connects to the port run privileged code in Zen, beyond controlling pages. The port is bound to `127.0.0.1` and is only open after `start`.
- No site blocking. Access is governed by the user's own setup and Claude Code's permission prompts.
- While remote control runs, Zen shows a striped address bar and robot icon, and sites can see `navigator.webdriver = true`. Quitting Zen and reopening it normally clears both.

## Budgets

| Area | Budget |
|---|---|
| Helper memory | physical footprint under 60 MB (RSS also counts about 54 MB of shared Node libraries) |
| Helper CPU when idle | close to 0%; exits after 10 idle minutes |
| Command latency | under 300 ms, excluding page load |
| `zen-cli read` time | under 1 s on a heavy page |
| `zen-cli read` compact output | about 1,500 tokens or less on a typical page |
| `zen-cli guide` | 800 tokens or less |
| Skill description | 50 tokens or less |
| Waiting | no open-ended polling; every wait has a timeout. Short bounded checks only where Zen sends no event: port at startup, scroll settling, dialogs without events |

## Steps

| # | Step | Acceptance criteria |
|---|---|---|
| 0 | Protocol checks on the real Zen (macOS) | **Done.** Results in [FINDINGS.md](FINDINGS.md). |
| 1 | Connection and helper | **Done.** Helper starts on first command, persists across commands, exits after 10 idle minutes; killing a command leaves no zombie session; helper ends its session on SIGINT, SIGTERM and errors; a zombie is detected and reported; memory, CPU and latency budgets met |
| 2 | Discovery and setup | **Done.** Zen app and default profile found without config; overrides work; `setup` is idempotent; no personal paths or user names in the source |
| 3 | Tabs and layout | **Done.** `zen-cli tabs --all` matches the sidebar across all Spaces, including unloaded tabs, with 50+ tabs; selected tab and active Space are correct; `go` loads an unloaded pinned tab; `open` on a pinned URL switches instead of duplicating; `open --space` leaves the user's Space unchanged; `layout` is correct both with Zen running and closed; plain-BiDi fallback works without system access |
| 4 | Reading | **Done.** Compact, full, subtree and find modes correct on a local test page (form, iframe, shadow DOM, cursor-pointer div, hidden checkbox switch) and on 3 real sites (GitHub, a news site, a self-hosted dashboard); read time and token budgets met |
| 5 | Interacting | **Done.** Click, type, select, upload, press, scroll, dialog, js and `--read` work on the test page and a real login-style form; every action prints its outcome; an open dialog never hangs a command |
| 6 | Guide and skill | **Done.** A fresh Claude session given only the skill completes a real task unaided; guide and skill budgets met |
| 7 | Launch and safety | **Done.** `zen-cli start` refuses without the safety pref, asks before restarting, relaunches with system access and restores tabs; Safe Browsing and popup blocker still on afterwards |
| 8 | Windows code paths | **Done for this build.** Windows discovery, named pipe, graceful quit and relaunch are written and exercised as far as possible from macOS (path resolution, argument building). **Not run on Windows**; tested on macOS only. A real Windows run comes later. |

## Verification layers

1. Protocol facts (step 0)
2. Local test page
3. Real sites
4. Fresh Claude session end to end
5. Safety prefs after launch
6. Budgets measured, not estimated
7. Source scan for personal paths and user names
8. Windows run of the full checklist (later, not part of this build)

## Out of scope

- Platforms other than macOS and Windows.
- Diff output ("what changed since last read"). Revisit only if measured reads stay heavy.
- Hiding automation from sites.
- Site allowlist or blocklist, audit log, MCP server.
- Editing the layout (Spaces, folders, pinned tabs) from the CLI.
