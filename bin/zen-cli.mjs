#!/usr/bin/env node
// zen-cli: read and drive the Zen browser over WebDriver BiDi.
// Copyright (c) 2026 r1ckrck. MIT License.
//
// The page walker, element-prepare, value-setter, text, scroll and input logic,
// and the covered-window workarounds are adapted from zenpilot
// (https://github.com/beSaif/zenpilot), Copyright (c) 2026 beSaif, MIT License.

import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, realpathSync, copyFileSync, openSync, closeSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, dirname, resolve as resolvePath, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const SELF = realpathSync(fileURLToPath(import.meta.url));
const BUILD = String(statSync(SELF).mtimeMs);
const DEFAULT_PORT = 9333;
const IDLE_MS = Number(process.env.ZEN_CLI_IDLE_MS) || 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 110_000;
const SAFETY_PREF = "remote.prefs.recommended";
const SAFETY_RE = /user_pref\(\s*"remote\.prefs\.recommended"\s*,\s*false\s*\)/;
const MAX_ITEMS = 600;
const COMPACT_CHARS = 5_400;
const FULL_CHARS = 12_000;
const TEXT_CHARS = 6_000;
const SHOTS_KEPT = 20;

class ZenError extends Error {}

// ---------------------------------------------------------------------------
// Platform: everything that differs between macOS and Windows lives here.
// ---------------------------------------------------------------------------

export function platformPaths(platform = process.platform, env = process.env, home = homedir(), tmp = tmpdir(), user = safeUser()) {
  if (platform === "win32") {
    const pf = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"), env.LOCALAPPDATA].filter(Boolean);
    return {
      zenRoot: join(env.APPDATA || join(home, "AppData", "Roaming"), "zen"),
      appCandidates: pf.flatMap(d => [join(d, "Zen Browser", "zen.exe"), join(d, "Zen", "zen.exe")]),
      socket: port => `\\\\.\\pipe\\zen-cli-${user}-${port}`,
      shotsDir: join(tmp, "zen-cli"),
      logFile: port => join(tmp, `zen-cli-${port}.log`),
    };
  }
  return {
    zenRoot: join(home, "Library", "Application Support", "zen"),
    appCandidates: ["/Applications/Zen.app", join(home, "Applications", "Zen.app")],
    socket: port => join(tmp, `zen-cli-${port}.sock`),
    shotsDir: join(tmp, "zen-cli"),
    logFile: port => join(tmp, `zen-cli-${port}.log`),
  };
}

function safeUser() {
  try { return userInfo().username.replace(/[^\w.-]/g, "_"); } catch { return "user"; }
}

const IS_WIN = process.platform === "win32";
const PATHS = platformPaths();

function run(cmd, args, timeout = 10_000) {
  return new Promise(res => execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => res(err ? null : String(stdout))));
}

// Zen executable: { app, bin }. app is the .app bundle on macOS, the exe on Windows.
export async function findZen(env = process.env) {
  const override = env.ZEN_CLI_APP;
  const candidates = override ? [override] : PATHS.appCandidates;
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (IS_WIN) return { app: c, bin: c };
    const bin = c.endsWith(".app") ? join(c, "Contents", "MacOS", "zen") : c;
    if (existsSync(bin)) return { app: c.endsWith(".app") ? c : null, bin };
  }
  if (override) throw new ZenError(`ZEN_CLI_APP points to ${override}, which doesn't exist.`);
  if (IS_WIN) {
    for (const hive of ["HKCU", "HKLM"]) {
      const out = await run("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\zen.exe`, "/ve"]);
      const m = out && out.match(/REG_SZ\s+(.+\.exe)/i);
      if (m && existsSync(m[1].trim())) return { app: m[1].trim(), bin: m[1].trim() };
    }
  } else {
    const out = await run("mdfind", ["kMDItemCFBundleIdentifier == 'app.zen-browser.zen'"]);
    const app = out && out.split("\n").map(s => s.trim()).find(p => p.endsWith(".app") && existsSync(join(p, "Contents", "MacOS", "zen")));
    if (app) return { app, bin: join(app, "Contents", "MacOS", "zen") };
  }
  throw new ZenError("Can't find Zen. Install it from https://zen-browser.app, or set ZEN_CLI_APP to its location.");
}

// Pid of the Zen process holding this profile, or null.
export async function zenHolder(profile) {
  if (IS_WIN) {
    // parent.lock stays on disk after exit; it's only held open while Zen runs.
    const lock = join(profile, "parent.lock");
    if (!existsSync(lock)) return null;
    try { closeSync(openSync(lock, "r+")); return null; } catch (e) { if (!["EBUSY", "EPERM", "EACCES"].includes(e.code)) return null; }
    const out = await run("tasklist", ["/FI", "IMAGENAME eq zen.exe", "/FO", "CSV", "/NH"]);
    const m = out && out.match(/"zen\.exe","(\d+)"/i);
    return m ? Number(m[1]) : -1;
  }
  const lock = join(profile, ".parentlock");
  if (!existsSync(lock)) return null;
  const out = await run("lsof", ["-t", lock]);
  const pid = out && parseInt(out.trim().split("\n")[0], 10);
  return pid || null;
}

// Quit the way Cmd+Q (macOS) or closing the windows (Windows) does, so the session saves.
export async function quitZen(pid, profile, timeout = 30_000) {
  // Without /F, taskkill asks Zen's windows to close, which saves the session.
  if (IS_WIN) await run("taskkill", ["/IM", "zen.exe"]);
  else await run("osascript", ["-l", "JavaScript", "-e", `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).terminate`]);
  const end = Date.now() + timeout;
  while (await zenHolder(profile)) {
    if (Date.now() > end) throw new ZenError("Zen didn't quit. It may be asking to confirm closing; answer that, then retry.");
    await sleep(300);
  }
}

export function launchArgs(profile, port) {
  return ["--profile", profile, "--remote-debugging-port", String(port), "--remote-allow-system-access"];
}

function launchZen(zen, profile, port) {
  const args = launchArgs(profile, port);
  const child = !IS_WIN && zen.app
    ? spawn("open", ["-na", zen.app, "--args", ...args], { detached: true, stdio: "ignore" })
    : spawn(zen.bin, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

// ---------------------------------------------------------------------------
// Profiles and prefs
// ---------------------------------------------------------------------------

export function parseIni(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = out[sec[1]] = {}; continue; }
    const eq = line.indexOf("=");
    if (cur && eq > 0) cur[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function readIni(file) {
  try { return parseIni(readFileSync(file, "utf8")); } catch { return {}; }
}

export function listProfiles(root) {
  const ini = readIni(join(root, "profiles.ini"));
  return Object.entries(ini)
    .filter(([k, v]) => k.startsWith("Profile") && v.Path)
    .map(([, v]) => ({ name: v.Name || v.Path, path: v.IsRelative === "0" ? v.Path : join(root, ...v.Path.split("/")), isDefault: v.Default === "1" }));
}

// { name, path } for --profile / ZEN_CLI_PROFILE, else Zen's default profile.
export function resolveProfile(override, root = PATHS.zenRoot) {
  const profiles = listProfiles(root);
  if (override) {
    if (existsSync(override) && statSync(override).isDirectory()) {
      const path = resolvePath(override);
      return { name: profiles.find(p => p.path === path)?.name || path, path };
    }
    const hit = profiles.find(p => p.name === override);
    if (hit) return hit;
    throw new ZenError(`No Zen profile named "${override}". Profiles: ${profiles.map(p => `"${p.name}"`).join(", ") || "none"}.`);
  }
  const installs = readIni(join(root, "installs.ini"));
  for (const v of Object.values(installs)) {
    if (!v.Default) continue;
    const path = isAbsolute(v.Default) ? v.Default : join(root, ...v.Default.split("/"));
    if (existsSync(path)) return { name: profiles.find(p => p.path === path)?.name || v.Default, path };
  }
  const def = profiles.find(p => p.isDefault && existsSync(p.path)) || profiles.find(p => existsSync(p.path));
  if (def) return def;
  throw new ZenError(`No Zen profile found in ${root}. Open Zen once to create one, or pass --profile.`);
}

export function hasSafetyPref(profile) {
  try { return SAFETY_RE.test(readFileSync(join(profile, "user.js"), "utf8")); } catch { return false; }
}

// ---------------------------------------------------------------------------
// mozlz4 and the session file (layout while Zen is closed)
// ---------------------------------------------------------------------------

export function mozlz4Decode(buf) {
  if (buf.subarray(0, 8).toString("latin1") !== "mozLz40\0") throw new ZenError("Not a mozlz4 file.");
  const size = buf.readUInt32LE(8);
  const src = buf.subarray(12);
  const out = Buffer.allocUnsafe(size);
  let i = 0, o = 0;
  while (i < src.length) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    src.copy(out, o, i, i + lit); i += lit; o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = tok & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out.subarray(0, o);
}

// Convert a session file into the same shape the live chrome query returns.
export function layoutFromSession(data) {
  const spaces = (data.spaces || []).map(s => ({ uuid: s.uuid, name: s.name }));
  const spaceName = Object.fromEntries(spaces.map(s => [s.uuid, s.name]));
  const folders = Object.fromEntries((data.folders || []).map(f => [f.id, f]));
  const path = id => { const out = []; for (let f = folders[id]; f; f = folders[f.parentId]) out.unshift(f.name); return out; };
  const tabs = (data.tabs || []).filter(t => !t.zenIsEmpty && !t.zenIsGlance).map(t => {
    const entry = t._zenPinnedInitialState?.entry || t.entries?.[(t.index || 1) - 1] || t.entries?.at(-1) || {};
    return {
      key: t.zenSyncId, title: entry.title || entry.url || "", url: entry.url || "",
      pinned: !!t.pinned, essential: !!t.zenEssential, space: t.zenEssential ? null : spaceName[t.zenWorkspace] || null,
      folder: t.groupId ? path(t.groupId) : [], pending: true, selected: false, ctx: null,
    };
  });
  return { spaces, activeSpace: null, tabs };
}

function readSessionFile(profile) {
  const file = join(profile, "zen-sessions.jsonlz4");
  if (!existsSync(file)) throw new ZenError(`No Zen session file in ${profile}.`);
  return layoutFromSession(JSON.parse(mozlz4Decode(readFileSync(file)).toString("utf8")));
}

// ---------------------------------------------------------------------------
// WebDriver BiDi client
// ---------------------------------------------------------------------------

class BiDiError extends Error {
  constructor(error, message) { super(`${error}: ${message}`); this.error = error; this.detail = message; }
}

class BiDi {
  #ws; #id = 0; #pending = new Map(); #waiters = new Set(); #handlers = [];
  onclose = null;

  static async connect(url, timeout = 5000) {
    const b = new BiDi();
    await new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => { ws.close(); rej(new Error("timeout")); }, timeout);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error("connect failed")); };
      b.#ws = ws;
    });
    b.#ws.onmessage = m => b.#dispatch(JSON.parse(m.data));
    b.#ws.onclose = () => {
      for (const p of b.#pending.values()) p.rej(new Error("connection closed"));
      b.#pending.clear();
      for (const w of b.#waiters) w.rej(new Error("connection closed"));
      b.#waiters.clear();
      b.onclose?.();
    };
    return b;
  }

  get open() { return this.#ws?.readyState === 1; }

  send(method, params = {}, timeout = 30_000) {
    if (!this.open) return Promise.reject(new Error("connection closed"));
    const id = ++this.#id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.#pending.delete(id)) rej(Object.assign(new Error(`Zen did not answer ${method} within ${timeout / 1000}s.`), { timeout: true })); }, timeout);
      this.#pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Resolves with the params of the next matching event; cancel() stops waiting.
  expect(method, pred = () => true) {
    let w;
    const waiters = this.#waiters;
    const promise = new Promise((res, rej) => { w = { method, pred, res, rej }; waiters.add(w); });
    promise.catch(() => {});
    let settled = false;
    promise.then(() => { settled = true; }, () => {});
    return { promise, cancel: () => waiters.delete(w), get done() { return settled; } };
  }

  on(method, fn) { this.#handlers.push({ method, fn }); }

  close() { try { this.#ws?.close(); } catch {} }

  #dispatch(msg) {
    if (msg.type === "event") {
      for (const h of this.#handlers) if (h.method === msg.method) h.fn(msg.params);
      for (const w of this.#waiters) if (w.method === msg.method && w.pred(msg.params)) { this.#waiters.delete(w); w.res(msg.params); }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    msg.type === "error" ? p.rej(new BiDiError(msg.error, msg.message)) : p.res(msg.result);
  }
}

function arg(v) {
  if (v && typeof v === "object" && "sharedId" in v) return v;
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "boolean", value: v };
  if (typeof v === "number") return { type: "number", value: v };
  return { type: "string", value: String(v) };
}

export function unwrap(v) {
  switch (v?.type) {
    case "string": case "boolean": return v.value;
    case "number": return typeof v.value === "number" ? v.value : null;
    case "null": case "undefined": return null;
    case "array": case "set": return (v.value || []).map(unwrap);
    case "object": case "map": return Object.fromEntries((v.value || []).map(([k, x]) => [typeof k === "string" ? k : String(unwrap(k)), unwrap(x)]));
    case "node": return { sharedId: v.sharedId };
    case "window": return { context: v.value?.context };
    case "regexp": return `/${v.value.pattern}/${v.value.flags || ""}`;
    case "date": return v.value;
    default: return v && "value" in v ? v.value : `[${v?.type}]`;
  }
}

// ---------------------------------------------------------------------------
// Scripts that run in Zen's browser window (chrome scope, needs system access).
// They are sent as source text; they never run in Node.
// ---------------------------------------------------------------------------

/* global Services, ChromeUtils */
function chromeState() {
  const w = Services.wm.getMostRecentBrowserWindow();
  const { gBrowser, gZenWorkspaces } = w;
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const spaces = (gZenWorkspaces?.getWorkspaces?.() || []).map(s => ({ uuid: s.uuid, name: s.name }));
  const spaceName = Object.fromEntries(spaces.map(s => [s.uuid, s.name]));
  const folderPath = tab => {
    const out = [];
    for (let g = tab.group; g; g = g.parentElement?.closest?.("zen-folder")) if (g.label) out.unshift(g.label);
    return out;
  };
  const tabs = [...w.document.querySelectorAll("tab.tabbrowser-tab")]
    .filter(t => !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-glance-tab") && !t.closing)
    .map(t => {
      const pending = t.hasAttribute("pending") || !t.linkedPanel;
      // Zen keeps tabs of inactive Spaces out of gBrowser.browsers, which also hides them from BiDi.
      const reachable = !pending && gBrowser.browsers.includes(t.linkedBrowser);
      let url = t.linkedBrowser?.currentURI?.spec || "";
      if (pending || url === "about:blank") {
        try { url = w.SessionStore.getLazyTabValue(t, "url") || url; } catch {}
        if (!url || url === "about:blank") url = t._zenPinnedInitialState?.entry?.url || url;
      }
      return {
        key: t.getAttribute("id") || t.linkedPanel || String(Math.random()), panel: t.linkedPanel || null,
        title: t.label || "", url, pinned: !!t.pinned, essential: t.hasAttribute("zen-essential"),
        space: t.hasAttribute("zen-essential") ? null : spaceName[t.getAttribute("zen-workspace-id")] || null,
        folder: folderPath(t), pending, selected: t === gBrowser.selectedTab,
        ctx: reachable ? NavigableManager.getIdForBrowser(t.linkedBrowser) : null, hidden: !pending && !reachable,
      };
    });
  return JSON.stringify({ spaces, activeSpace: spaceName[gZenWorkspaces?.activeWorkspace] || null, tabs });
}

function chromeSelect(key) {
  const w = Services.wm.getMostRecentBrowserWindow();
  const { gBrowser, gZenWorkspaces } = w;
  const tab = [...w.document.querySelectorAll("tab.tabbrowser-tab")].find(t => t.getAttribute("id") === key || t.linkedPanel === key);
  if (!tab) return JSON.stringify({ error: "gone" });
  const space = tab.getAttribute("zen-workspace-id");
  const select = () => { gBrowser.selectedTab = tab; };
  const done = new Promise(res => {
    const finish = () => {
      const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
      res(JSON.stringify({ ctx: tab.linkedPanel ? NavigableManager.getIdForBrowser(tab.linkedBrowser) : null, loading: tab.hasAttribute("pending") || tab.hasAttribute("busy") }));
    };
    const start = Date.now();
    // An unloaded tab is "pending" until selected, then "busy" until its page loads.
    const check = () => (!tab.hasAttribute("pending") && !tab.hasAttribute("busy") && tab.linkedPanel) || Date.now() - start > 15_000 ? finish() : w.setTimeout(check, 50);
    if (space && !tab.hasAttribute("zen-essential") && space !== gZenWorkspaces.activeWorkspace) {
      gZenWorkspaces.changeWorkspaceWithID(space).then(() => { select(); check(); }, () => { select(); check(); });
    } else { select(); check(); }
  });
  return done;
}

function chromeNewTab(spaceName, url) {
  const w = Services.wm.getMostRecentBrowserWindow();
  const { gBrowser, gZenWorkspaces } = w;
  const space = gZenWorkspaces.getWorkspaces().find(s => s.name.toLowerCase() === String(spaceName).toLowerCase());
  if (!space) return JSON.stringify({ error: "no-space", spaces: gZenWorkspaces.getWorkspaces().map(s => s.name) });
  // A blank tab would become Zen's empty-tab placeholder, so open the real URL directly.
  const tab = gBrowser.addTrustedTab(url, { inBackground: true });
  if (space.uuid !== gZenWorkspaces.activeWorkspace) gZenWorkspaces.moveTabToWorkspace(tab, space.uuid);
  // Moving a tab between Spaces can swap its browser, so the caller looks up the context afterwards.
  return JSON.stringify({ key: tab.getAttribute("id") || tab.linkedPanel, panel: tab.linkedPanel });
}

function chromeClose(key) {
  const w = Services.wm.getMostRecentBrowserWindow();
  const tab = [...w.document.querySelectorAll("tab.tabbrowser-tab")].find(t => t.getAttribute("id") === key || t.linkedPanel === key);
  if (!tab) return false;
  w.gBrowser.removeTab(tab);
  return true;
}

// Open alert/confirm/prompt/leave-page dialogs on every tab. Events only cover dialogs
// opened during this session, so this is the source of truth with system access.
function chromePrompts() {
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const out = [];
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    for (const t of w.document.querySelectorAll("tab.tabbrowser-tab")) {
      const box = t.linkedPanel && t.linkedBrowser?.tabDialogBox;
      if (!box) continue;
      for (const d of [...box.getTabDialogManager().dialogs, ...box.getContentDialogManager().dialogs]) {
        const D = d.frameContentWindow?.Dialog;
        if (!D) continue;
        const a = D.args || {};
        const type = a.inPermitUnload ? "beforeunload" : /^prompt/.test(a.promptType) ? "prompt" : /^confirm/.test(a.promptType) ? "confirm" : "alert";
        out.push({ context: NavigableManager.getIdForBrowser(t.linkedBrowser), type, message: D.ui?.infoBody?.textContent || a.text || "" });
      }
    }
  }
  return JSON.stringify(out);
}

// Answer the first dialog on a tab through its own buttons; covers types BiDi can't handle
// (alertCheck, confirmCheck: the variants with "don't allow this site to prompt again").
function chromeAnswer(ctx, accept, text) {
  const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
  const browser = NavigableManager.getBrowserById(ctx);
  const box = browser?.tabDialogBox;
  const d = box && [...box.getTabDialogManager().dialogs, ...box.getContentDialogManager().dialogs][0];
  const D = d?.frameContentWindow?.Dialog;
  if (!D) return false;
  const { button0, button1, loginTextbox } = D.ui;
  if (accept && text !== null && loginTextbox && !loginTextbox.hidden) loginTextbox.value = text;
  (accept ? button0 : button1 || button0).click();
  return true;
}

// Uploads need File.createFromFileName in the content process. Enabled only around setFiles.
function chromeFilePref(value) {
  const P = Services.prefs, name = "dom.file.createInChild";
  const prev = P.prefHasUserValue(name) ? P.getBoolPref(name) : null;
  if (value === null) P.clearUserPref(name); else P.setBoolPref(name, value);
  return JSON.stringify({ prev });
}

function chromeStatus() {
  const P = Services.prefs;
  const b = n => { try { return P.getBoolPref(n); } catch { return null; } };
  return JSON.stringify({ safeBrowsing: b("browser.safebrowsing.malware.enabled"), popupBlocker: b("dom.disable_open_during_load"), fileInChild: b("dom.file.createInChild"), version: Services.appinfo.version });
}

// ---------------------------------------------------------------------------
// Scripts that run in web pages (content scope).
// ---------------------------------------------------------------------------

// Walks the rendered tree (including open shadow roots) and returns [items, truncated].
// Each item is [depth, line, node|null, frameWindow|null, isSection]; nodes come back as BiDi sharedIds.
function pageWalker(maxItems, root, wide) {
  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
    ...["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
      "option", "switch", "textbox", "combobox", "searchbox", "slider", "spinbutton", "treeitem"].map(r => `[role=${r}]`),
  ].join(",");
  const LANDMARKS = new Set(["HEADER", "NAV", "MAIN", "ASIDE", "FOOTER", "FORM", "DIALOG", "FIELDSET"]);
  const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "form", "dialog", "alertdialog", "search"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "svg", "math"]);
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", search: "searchbox", file: "file" };
  const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const clip = (s, n) => { if (wide) n *= 4; s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const q = s => JSON.stringify(s);
  // Result and error messages: ARIA live regions, or short blocks named like flash/alert/toast.
  const STATUS_ROLES = new Set(["alert", "status", "log"]);
  const isStatus = el => STATUS_ROLES.has(el.getAttribute("role")) || ["polite", "assertive"].includes(el.getAttribute("aria-live")) ||
    /(^|[\s_-])(flash|alert|toast|notice|notification|error|success|warning)([\s_-]|$)/i.test(`${el.id} ${typeof el.className === "string" ? el.className : ""}`);
  const parentOf = el => el.assignedSlot || el.parentElement || el.getRootNode().host || null;
  const inControl = el => { for (let a = el; a; a = parentOf(a)) if (a.matches(INTERACTIVE)) return true; return false; };
  const rendered = el => el.checkVisibility({ checkVisibilityCSS: true }) || getComputedStyle(el).display === "contents";
  const hasBox = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const shown = el => rendered(el) && hasBox(el);
  // JS-only controls usually set cursor: pointer; count only where it starts.
  const pointerRoot = el => {
    if (!(el instanceof HTMLElement) || el.tagName === "BODY" || (el.tagName === "LABEL" && el.control)) return false;
    if (getComputedStyle(el).cursor !== "pointer" || el.querySelector(INTERACTIVE) || el.closest("label")?.control) return false;
    const p = parentOf(el);
    return !(p instanceof Element) || (getComputedStyle(p).cursor !== "pointer" && !inControl(p));
  };
  // A checkbox or radio hidden behind a styled switch: the ref goes to what the user clicks.
  const standInFor = el => {
    if (el.tagName !== "INPUT" || (el.type !== "checkbox" && el.type !== "radio") || shown(el)) return null;
    const label = [...el.labels].find(shown);
    if (label) return label;
    for (let p = parentOf(el); p && p !== document.body && rendered(p); p = parentOf(p)) if (hasBox(p)) return p;
    return null;
  };
  const hasInner = new Set(), pointy = new Set(), standIn = new Map();
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll("*")) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      let interesting = el.shadowRoot || el.tagName === "IFRAME" || el.tagName === "FRAME";
      if (el.matches(INTERACTIVE)) { interesting = true; const s = standInFor(el); if (s) standIn.set(el, s); }
      else if (pointerRoot(el)) { interesting = true; pointy.add(el); }
      if (!interesting) continue;
      for (let p = parentOf(el); p && !hasInner.has(p); p = parentOf(p)) hasInner.add(p);
    }
  }
  for (const s of standIn.values()) pointy.delete(s);
  const isControl = el => el.matches(INTERACTIVE) || pointy.has(el);
  const role = el => {
    const r = el.getAttribute("role");
    if (r) return r;
    switch (el.tagName) {
      case "A": return "link";
      case "BUTTON": case "SUMMARY": return "button";
      case "SELECT": return "select";
      case "TEXTAREA": return "textbox";
      case "INPUT": return INPUT_ROLES[el.type] || "textbox";
    }
    return el.isContentEditable ? "textbox" : "clickable";
  };
  const name = (el, si) => {
    let n = el.getAttribute("aria-label");
    const ids = !n && el.getAttribute("aria-labelledby");
    if (ids) n = ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || "").join(" ");
    if (!n && el.labels?.length) n = [...el.labels].map(l => l.innerText.trim()).find(Boolean);
    if (!n && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) n = el.placeholder || el.title || (["submit", "button", "reset"].includes(el.type) ? el.value : "") || el.alt;
    if (!n) n = el.innerText || el.title || el.querySelector?.("img[alt]")?.alt || si?.innerText || "";
    return clip(n, 80);
  };
  const describe = (el, si) => {
    const r = role(el);
    let line = r;
    const n = name(el, si);
    if (n) line += " " + q(n);
    if (r === "textbox" && el.tagName === "INPUT" && el.type !== "text") line += ` type=${el.type}`;
    if (el.tagName === "SELECT") line += " value=" + q(clip(el.selectedOptions[0]?.text, 40));
    else if ((r === "textbox" || r === "searchbox") && el.value) line += " value=" + (el.type === "password" ? '"•••"' : q(clip(el.value, 60)));
    else if (el.isContentEditable && el.innerText.trim() && n !== clip(el.innerText, 80)) line += " value=" + q(clip(el.innerText, 60));
    else if (r === "file" && el.files?.length) line += " value=" + q(clip([...el.files].map(f => f.name).join(", "), 60));
    const ac = el.getAttribute("aria-checked");
    if (el.indeterminate || ac === "mixed") line += " mixed";
    else if (el.checked || ac === "true") line += " checked";
    else if (TOGGLE_ROLES.has(r)) line += " unchecked";
    if (el.getAttribute("aria-selected") === "true") line += " selected";
    const exp = el.getAttribute("aria-expanded");
    if (exp) line += exp === "true" ? " expanded" : " collapsed";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " disabled";
    if (el.tagName === "A" && el.href && !el.href.startsWith("javascript:")) {
      try { const u = new URL(el.href); line += " -> " + clip(u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname, 60); } catch {}
    }
    return line;
  };
  const out = [];
  let truncated = false;
  const emit = (depth, line, node = null, frame = null, section = false) => {
    if (out.length >= maxItems) { truncated = true; return false; }
    out.push([depth, line, node, frame, section]);
    return true;
  };
  const children = el => {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === "SLOT") { const a = el.assignedNodes({ flatten: true }); return a.length ? a : [...el.childNodes]; }
    return [...el.childNodes];
  };
  const walk = (node, depth, named = "") => {
    if (truncated) return;
    if (node.nodeType === 3) {
      const t = clip(node.data, 100);
      const parent = node.parentElement;
      if (t.length > 1 && !named.includes(t) && !(parent && isControl(parent)) && !parent?.closest("label")?.control) emit(depth, q(t));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return;
    const s = standIn.get(el);
    if (s) { if (!s.matches(INTERACTIVE)) emit(depth, describe(el, s), s); return; }
    if (!rendered(el)) return;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      if (hasBox(el)) emit(depth, "frame " + q(clip(el.title || el.name || el.src, 60)), null, el.contentWindow);
      return;
    }
    if (isControl(el)) {
      if (hasBox(el)) emit(depth, describe(el), el);
      if (hasInner.has(el)) for (const c of children(el)) walk(c, depth + 1, name(el));
      return;
    }
    if (isStatus(el) && el.innerText.trim() && el.innerText.length <= 300) {
      const t = clip(el.innerText, 150);
      if (!named.includes(t)) emit(depth, "status " + q(t));
      if (hasInner.has(el)) for (const c of children(el)) walk(c, depth + 1, named + " " + t);
      return;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      const t = clip(el.innerText, 100);
      if (t) emit(depth, el.tagName.toLowerCase() + " " + q(t));
      if (hasInner.has(el)) for (const c of children(el)) walk(c, depth + 1, named);
      return;
    }
    if (el.tagName === "IMG") {
      const alt = clip(el.alt, 80);
      if (alt && el.width >= 24 && el.height >= 24) emit(depth, "img " + q(alt));
      return;
    }
    const roleAttr = el.getAttribute("role");
    if (LANDMARKS.has(el.tagName) || LANDMARK_ROLES.has(roleAttr)) {
      const label = clip(el.getAttribute("aria-label") || "", 40);
      const at = out.length;
      emit(depth, (roleAttr || el.tagName.toLowerCase()) + (label ? " " + q(label) : ""), el, null, true);
      for (const c of children(el)) walk(c, depth + 1, named);
      if (out.length === at + 1 && !truncated) out.pop();
      return;
    }
    if (el.tagName === "LABEL" && el.control) {
      if (hasInner.has(el)) for (const c of children(el)) walk(c, depth, named);
      return;
    }
    if (el.tagName !== "SLOT" && !hasInner.has(el) && (el.children.length === 0 || el.innerText.length <= 200)) {
      const t = clip(el.innerText, 100);
      if (t.length > 1 && !named.includes(t)) emit(depth, q(t));
      return;
    }
    for (const c of children(el)) walk(c, depth, named);
  };
  if (root) {
    if (!root.isConnected) return [[[0, "[stale]", null, null]], false];
    if (isControl(root) && hasBox(root)) emit(0, describe(root), root);
    for (const c of children(root)) walk(c, root === document.body ? 0 : 1, isControl(root) ? name(root) : "");
  } else walk(document.body || document.documentElement, 0);
  return [out, truncated];
}

// Scrolls the element into view and reports anything covering its center.
function pagePrepare(el) {
  if (!el.isConnected) return ["stale", "", "", ""];
  if (!innerWidth || !innerHeight) return ["noviewport", "", "", ""];
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return ["hidden", el.tagName, "", ""];
  const top = el.getRootNode().elementFromPoint?.(r.left + r.width / 2, r.top + r.height / 2);
  const ok = !top || el === top || el.contains(top) || top.contains(el) || top.control === el;
  const classes = typeof top?.className === "string" ? top.className.trim().split(/\s+/).filter(Boolean) : [];
  const cover = ok ? "" : top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (classes.length ? "." + classes.slice(0, 2).join(".") : "");
  return ["ok", el.tagName, cover, el.tagName === "INPUT" ? el.type : ""];
}

function pageSelectContent(el) {
  if (typeof el.select === "function" && el.type !== "file") el.select();
  else if (el.isContentEditable) getSelection().selectAllChildren(el);
}

// Uses the prototype's setter so frameworks like React notice the change.
function pageSetValue(el, v) {
  if (el.disabled || el.readOnly) return null;
  el.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const old = el.value;
  set.call(el, v);
  if (v && !el.value) { set.call(el, old); return ""; }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}

function pageSelectOption(el, wanted) {
  if (el.tagName !== "SELECT") return ["not-select", []];
  if (el.disabled) return ["disabled", []];
  const opts = [...el.options];
  const w = String(wanted).trim().toLowerCase();
  const hit = opts.find(o => o.text.trim().toLowerCase() === w) || opts.find(o => o.value.toLowerCase() === w) || opts.find(o => o.text.trim().toLowerCase().includes(w));
  if (!hit) return ["no-match", opts.slice(0, 30).map(o => o.text.trim())];
  el.focus();
  el.value = hit.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return ["ok", [hit.text.trim()]];
}

function pageText(max) {
  const articles = document.querySelectorAll("article");
  const root = document.querySelector("main, [role=main]") || (articles.length === 1 ? articles[0] : document.body);
  const text = (root?.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return [document.title, text.length, text.slice(0, max)];
}

function pageTabState() { return [document.title, document.visibilityState, document.hasFocus()]; }

function pageScrollInfo() {
  return [innerWidth, innerHeight, scrollX, scrollY, document.documentElement.scrollWidth, document.documentElement.scrollHeight];
}

function pageScrollState() {
  const out = [scrollX, scrollY];
  for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement) out.push(el.scrollLeft, el.scrollTop);
  return out.join(",");
}

// Fallback when wheel events don't scroll (a covered Zen window ignores them).
function pageScrollFallback(dx, dy) {
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    const canY = dy && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
    const canX = dx && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth;
    if (canY || canX) break;
  }
  const target = el && el !== document.documentElement ? el : document.scrollingElement;
  target.scrollBy({ left: dx, top: dy, behavior: "instant" });
}

// ---------------------------------------------------------------------------
// Outline rendering
// ---------------------------------------------------------------------------

const TEXT_LINE = line => line.startsWith('"') || line.startsWith("img ");
const HEADING = line => /^h[1-6] /.test(line) || line.startsWith("status ");

// items: [{ depth, line, ref, section }]; ref is set for interactive nodes and sections (section: true).
export function renderOutline(items, { mode = "compact", find = null, truncated = false } = {}) {
  const notes = [];
  let list = items;
  if (find) {
    const needle = find.toLowerCase();
    const keep = new Set();
    const urlish = /[/.]/.test(needle);
    list.forEach((it, i) => {
      const hay = (urlish ? it.line : it.line.replace(/ -> .*$/, "")).toLowerCase();
      if (!hay.includes(needle)) return;
      keep.add(i);
      for (let j = i - 1, d = it.depth; j >= 0 && d > 0; j--) if (list[j].depth < d) { keep.add(j); d = list[j].depth; }
      for (let j = i + 1; j < list.length && list[j].depth > it.depth; j++) keep.add(j);
    });
    list = list.filter((_, i) => keep.has(i));
    if (!list.length) return `[nothing matches "${find}"]`;
  } else if (mode === "compact") {
    list = list.filter(it => it.ref || !TEXT_LINE(it.line));
    // drop containers left with nothing under them
    list = list.filter((it, i) => (it.ref && !it.section) || HEADING(it.line) || it.line.startsWith("frame ") || (list[i + 1] && list[i + 1].depth > it.depth));
  }
  const cap = mode === "full" ? FULL_CHARS : COMPACT_CHARS;
  if (mode === "full" && list.reduce((n, it) => n + it.line.length + 2 * it.depth + 8, 0) > cap) {
    list = list.filter(it => it.ref || !TEXT_LINE(it.line));
    notes.push("[plain text omitted to fit; use zen-cli text]");
  }
  const lines = [];
  let size = 0, shown = 0;
  // Compact keeps link targets short: enough to tell links apart.
  const shorten = l => (mode === "compact" ? l.replace(/ -> (.{40}).+$/, " -> $1…") : l);
  for (const it of list) {
    const line = "  ".repeat(it.depth) + (it.ref ? it.ref + " " : "") + shorten(it.line);
    if (size + line.length + 1 > cap) { truncated = true; break; }
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  if (truncated) notes.push(`[truncated: showing ${shown} of ${list.length} lines; use read eN for a section, --find "text", or scroll]`);
  return lines.length ? [...lines, ...notes].join("\n") : "[no visible content]";
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEYS = {
  enter: "", return: "", tab: "", escape: "", esc: "", backspace: "", delete: "",
  space: " ", arrowleft: "", left: "", arrowup: "", up: "", arrowright: "", right: "",
  arrowdown: "", down: "", home: "", end: "", pageup: "", pagedown: "", insert: "",
  shift: "", control: "", ctrl: "", alt: "", option: "", meta: "", cmd: "", command: "",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, String.fromCharCode(0xe031 + i)])),
};
const ENTER = KEYS.enter, SHIFT = KEYS.shift, BACKSPACE = KEYS.backspace;

// "Meta+Shift+K" -> ["", "", "k"]
export function parseChord(spec) {
  const parts = spec.split("+").filter(Boolean);
  if (!parts.length) throw new ZenError(`Empty key "${spec}".`);
  return parts.map(p => {
    const k = KEYS[p.toLowerCase()];
    if (k) return k;
    if ([...p].length === 1) return parts.length > 1 ? p.toLowerCase() : p;
    throw new ZenError(`Unknown key "${p}". Use names like Enter, Tab, Escape, ArrowDown, PageDown, F5, or a single character, joined with + (Meta+L).`);
  });
}

// ---------------------------------------------------------------------------
// Browser state, held by the helper
// ---------------------------------------------------------------------------

const STALE = new Set(["no such node", "no such element", "stale element reference", "detached shadow root", "no such frame"]);

class Browser {
  bidi = null; sys = false; chrome = null; port;
  tabIds = new Map(); tabKeys = new Map(); nextTab = 1;
  refs = new Map(); nextRef = 1;
  prompts = new Map();
  lastCtx = null;
  own = new Set(); // contexts of tabs zen-cli opened; open only navigates these in place

  constructor(port) { this.port = port; }

  async ensure() {
    if (this.bidi?.open) return;
    this.reset();
    let bidi;
    try { bidi = await BiDi.connect(`ws://127.0.0.1:${this.port}/session`); }
    catch { throw new ZenError(`Zen isn't running with remote control on port ${this.port}. Run zen-cli start.`); }
    try {
      await bidi.send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
    } catch (e) {
      bidi.close();
      if (e.error === "session not created") throw new ZenError("Zen has a stuck automation session (a previous helper was killed). Run zen-cli start --restart to restart Zen.");
      throw e;
    }
    bidi.on("browsingContext.userPromptOpened", p => this.prompts.set(p.context, p));
    bidi.on("browsingContext.userPromptClosed", p => this.prompts.delete(p.context));
    bidi.on("browsingContext.contextDestroyed", p => this.prompts.delete(p.context));
    await bidi.send("session.subscribe", { events: ["browsingContext.navigationStarted", "browsingContext.load", "browsingContext.contextCreated", "browsingContext.contextDestroyed", "browsingContext.userPromptOpened", "browsingContext.userPromptClosed"] });
    try {
      const tree = await bidi.send("browsingContext.getTree", { maxDepth: 0, "moz:scope": "chrome" });
      this.chrome = tree.contexts.find(c => c.url.startsWith("chrome://browser/content/browser"))?.context || null;
      this.sys = !!this.chrome;
    } catch { this.sys = false; }
    bidi.onclose = () => { if (this.bidi === bidi) this.reset(); };
    this.bidi = bidi;
  }

  reset() {
    this.bidi = null; this.sys = false; this.chrome = null; this.own = new Set();
    this.refs.clear(); this.prompts.clear(); this.lastCtx = null;
  }

  async close() {
    if (!this.bidi?.open) return;
    try { await this.bidi.send("session.end", {}, 2000); } catch {}
    this.bidi.close();
    this.reset();
  }

  call(method, params, timeout) { return this.bidi.send(method, params, timeout); }

  async chromeCall(fn, ...args) {
    const r = await this.call("script.callFunction", { functionDeclaration: fn.toString(), target: { context: this.chrome }, arguments: args.map(arg), awaitPromise: true, resultOwnership: "none" }, 20_000);
    if (r.type === "exception") throw new ZenError(`Zen script error: ${r.exceptionDetails?.text}`);
    const v = unwrap(r.result);
    return typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? JSON.parse(v) : v;
  }

  async page(ctx, fn, args = [], timeout = 15_000) {
    this.assertNoPrompt(ctx);
    const r = await this.call("script.callFunction", {
      functionDeclaration: fn.toString(), target: { context: ctx }, arguments: args.map(arg),
      awaitPromise: true, resultOwnership: "none", serializationOptions: { maxDomDepth: 0 },
    }, timeout);
    if (r.type === "exception") throw new ZenError(`Script error in page: ${r.exceptionDetails?.text || "unknown"}`);
    return unwrap(r.result);
  }

  assertNoPrompt(ctx) {
    const p = ctx ? this.prompts.get(ctx) : this.prompts.values().next().value;
    if (p) throw new ZenError(`A ${p.type} dialog is open${this.tabIdForCtx(p.context) ? " in " + this.tabIdForCtx(p.context) : ""}: ${JSON.stringify(clipText(p.message, 120))}. Answer it with zen-cli dialog accept|dismiss.`);
  }

  // -- tabs -------------------------------------------------------------------

  idFor(key) {
    if (!this.tabIds.has(key)) { const id = `t${this.nextTab++}`; this.tabIds.set(key, id); this.tabKeys.set(id, key); }
    return this.tabIds.get(key);
  }

  tabIdForCtx(ctx) {
    for (const [key, id] of this.tabIds) if (key === ctx || this.ctxOf.get(key) === ctx) return id;
    return null;
  }

  ctxOf = new Map();

  async state() {
    if (this.sys) {
      const s = await this.chromeCall(chromeState);
      for (const t of s.tabs) { t.id = this.idFor(t.key); if (t.ctx) this.ctxOf.set(t.key, t.ctx); }
      return s;
    }
    const contexts = (await this.call("browsingContext.getTree", { maxDepth: 0 })).contexts;
    const states = await Promise.all(contexts.map(c => this.page(c.context, pageTabState, [], 3000).catch(() => ["", "hidden", false])));
    const tabs = contexts.map((c, i) => ({ key: c.context, ctx: c.context, url: c.url, title: states[i][0] || "", pinned: false, essential: false, space: null, folder: [], pending: false, selected: false, rank: 4 * states[i][2] + 2 * (states[i][1] === "visible") + 2.5 * (c.context === this.lastCtx) }));
    if (tabs.length) tabs.reduce((a, b) => (b.rank > a.rank ? b : a)).selected = true;
    for (const t of tabs) t.id = this.idFor(t.key);
    return { spaces: [], activeSpace: null, tabs };
  }

  async tab(id) {
    const s = await this.state();
    if (!id) {
      const t = s.tabs.find(t => t.selected);
      if (!t) throw new ZenError("No selected tab. Run zen-cli tabs, then pass a tab id.");
      return t;
    }
    const key = this.tabKeys.get(id.toLowerCase());
    const t = key && s.tabs.find(t => t.key === key);
    if (!t) throw new ZenError(`Unknown tab ${id}. Run zen-cli tabs for current ids.`);
    return t;
  }

  async loadedTab(id) {
    const t = await this.tab(id);
    if (t.hidden) throw new ZenError(`${t.id} is in the ${t.space} Space, which isn't active. zen-cli go ${t.id} switches to it (this moves the user's view).`);
    if (!t.ctx) throw new ZenError(`${t.id} isn't loaded. Run zen-cli go ${t.id} first.`);
    return t;
  }

  async activate(t) {
    if (this.sys) {
      const r = await this.chromeCall(chromeSelect, t.key);
      if (r.error) throw new ZenError(`${t.id} is gone. Run zen-cli tabs.`);
      if (r.ctx) { this.ctxOf.set(t.key, r.ctx); this.lastCtx = r.ctx; }
      return { ctx: r.ctx, loading: r.loading || !r.ctx };
    }
    this.lastCtx = t.ctx;
    try { await this.call("browsingContext.activate", { context: t.ctx }, 1000); } catch (e) { if (!e.timeout) throw e; }
    return { ctx: t.ctx, loading: false };
  }

  // With a Space, returns { key } of a tab loading there in the background; otherwise { ctx }.
  async newTab(space, url) {
    if (space) {
      if (!this.sys) throw new ZenError("--space needs system access. Run zen-cli start --restart.");
      const r = await this.chromeCall(chromeNewTab, space, url);
      if (r.error) throw new ZenError(`No Space named "${space}". Spaces: ${r.spaces.join(", ")}.`);
      return r;
    }
    // A foreground create waits for visibility, which a covered window never reports.
    const { context } = await this.call("browsingContext.create", { type: "tab", background: true });
    try { await this.call("browsingContext.activate", { context }, 1000); } catch (e) { if (!e.timeout) throw e; }
    this.lastCtx = context;
    this.own.add(context);
    return { ctx: context };
  }

  async navigate(ctx, url) {
    this.assertNoPrompt(ctx);
    this.dropRefs(ctx);
    let loading = false;
    try { await this.call("browsingContext.navigate", { context: ctx, url, wait: "complete" }, 30_000); }
    catch (e) {
      if (e.timeout) loading = true;
      else if (e instanceof BiDiError) throw new ZenError(`Navigation to ${clipText(url, 100)} failed: ${e.detail || e.error}`);
      else throw e;
    }
    return { url: await this.urlOf(ctx), loading };
  }

  async urlOf(ctx) {
    return (await this.call("browsingContext.getTree", { root: ctx, maxDepth: 0 })).contexts[0]?.url || "";
  }

  dropRefs(ctx) { for (const [k, r] of this.refs) if (r.top === ctx) this.refs.delete(k); }

  // -- reading --------------------------------------------------------------------

  async collect(top, rootRef, wide = false) {
    const items = [];
    let truncated = false;
    const visit = async (ctx, base, root) => {
      const [out, trunc] = await this.page(ctx, pageWalker, [MAX_ITEMS, root || null, wide], 20_000);
      truncated ||= trunc;
      for (const [depth, line, node, frame, section] of out) {
        const item = { depth: base + depth, line, ctx, node: node?.sharedId || null, section };
        items.push(item);
        if (frame?.context) {
          try { await visit(frame.context, base + depth + 1, null); } catch { item.line += " [not readable]"; }
        }
      }
    };
    await visit(rootRef ? rootRef.ctx : top, 0, rootRef ? { sharedId: rootRef.sharedId } : null);
    return { items, truncated };
  }

  async read(t, { section, mode, find }) {
    let rootRef = null;
    if (section) rootRef = this.ref(section);
    const top = rootRef ? rootRef.top : t.ctx;
    const wide = mode === "full";
    let { items, truncated } = await this.collect(top, rootRef, wide);
    // Single-page apps often render after load: give a near-empty page a moment.
    for (let i = 0; !rootRef && items.length <= 2 && i < 3; i++) { await sleep(500); ({ items, truncated } = await this.collect(top, null, wide)); }
    if (!rootRef) this.dropRefs(top);
    for (const it of items) if (it.node) { it.ref = `e${this.nextRef++}`; this.refs.set(it.ref, { ctx: it.ctx, sharedId: it.node, top }); }
    const body = renderOutline(items, { mode, find, truncated });
    // Refs that didn't make it into the output are useless; free them.
    for (const it of items) if (it.ref && !body.includes(it.ref + " ")) this.refs.delete(it.ref);
    return body;
  }

  ref(key) {
    const r = this.refs.get(String(key).toLowerCase());
    if (!r) throw new ZenError(`Unknown ref ${key}. Refs come from the latest zen-cli read of that tab; read again.`);
    return r;
  }

  async prepare(key) {
    const r = this.ref(key);
    let res;
    try { res = await this.page(r.ctx, pagePrepare, [{ sharedId: r.sharedId }]); }
    catch (e) { if (STALE.has(e.error)) throw stale(key); throw e; }
    const [status, tag, cover, kind] = res;
    if (status === "stale") throw stale(key);
    if (status === "noviewport") throw new ZenError("The page area has no size, so clicks can't land (Zen's welcome screen may still be open). Run zen-cli setup, then zen-cli start --restart.");
    if (status === "hidden") throw new ZenError(`${key} isn't visible anymore. Read again.`);
    return { r, tag, cover, kind };
  }

  async actions(ctx, actions) { await this.call("input.performActions", { context: ctx, actions }, 15_000); }

  async click(r) {
    const origin = { type: "element", element: { sharedId: r.sharedId } };
    await this.actions(r.ctx, [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: 0, y: 0, origin }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }]);
  }

  async keys(ctx, keys) {
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = [];
      for (const k of keys.slice(i, i + 100)) {
        const chord = Array.isArray(k) ? k : [k];
        chunk.push(...chord.map(value => ({ type: "keyDown", value })), ...[...chord].reverse().map(value => ({ type: "keyUp", value })));
      }
      await this.actions(ctx, [{ type: "key", id: "keyboard", actions: chunk }]);
    }
  }

  // Run an input action and report navigation, new tabs and dialogs it caused.
  async settle(top, action) {
    const started = this.bidi.expect("browsingContext.navigationStarted", p => p.context === top);
    const loaded = this.bidi.expect("browsingContext.load", p => p.context === top);
    const created = this.bidi.expect("browsingContext.contextCreated", p => !p.parent);
    const prompt = this.bidi.expect("browsingContext.userPromptOpened", () => true);
    try {
      // A dialog blocks the page, so the input command only returns once it's answered.
      const act = action();
      act.catch(() => {});
      // Some dialog types (alertCheck, confirmCheck) send no event, so with system access
      // look for one a few times while the input command is still running.
      const found = { promise: null };
      const probe = async () => {
        for (const ms of [500, 1000, 2500, 5000]) {
          await sleep(ms);
          if (found.stop) return null;
          const open = (await this.chromeCall(chromePrompts).catch(() => [])).find(p => p.context === top);
          if (open) return open;
        }
        return new Promise(() => {});
      };
      const probed = this.sys ? probe() : new Promise(() => {});
      let first;
      try { first = await Promise.race([act.then(() => "done"), prompt.promise.then(() => "prompt"), probed.then(p => p && (found.dialog = p, "probe"))]); }
      catch (e) {
        if (e.timeout && !this.sys) throw new ZenError("The page didn't respond; a dialog zen-cli can't see without system access (repeated alerts) may be blocking it. Ask the user to answer it, or run zen-cli start --restart.");
        throw e;
      }
      finally { found.stop = true; }
      if (first === "probe") {
        this.prompts.set(found.dialog.context, found.dialog);
        return [`A ${found.dialog.type} dialog opened: ${JSON.stringify(clipText(found.dialog.message, 120))}. Answer with zen-cli dialog accept|dismiss`];
      }
      if (first === "done") {
        await Promise.race([started.promise, created.promise, prompt.promise, sleep(400)]);
        if (!prompt.done && this.sys) {
          const open = (await this.chromeCall(chromePrompts).catch(() => [])).find(p => p.context === top);
          if (open) { found.dialog = open; first = "probe"; }
        }
      }
      const notes = [];
      if (started.done) {
        this.dropRefs(top);
        const ok = await Promise.race([loaded.promise.then(() => true), prompt.promise.then(() => false), sleep(15_000).then(() => null)]);
        notes.push(ok === true ? `Page navigated to ${clipText(await this.urlOf(top), 100)}` : ok === null ? "A navigation started and is still loading" : "Navigation paused");
      }
      if (created.done) {
        const p = await created.promise;
        this.lastCtx = p.context;
        const t = (await this.state().catch(() => ({ tabs: [] }))).tabs.find(x => x.ctx === p.context);
        notes.push(`A new tab ${t ? t.id + " " : ""}opened${p.url && p.url !== "about:blank" ? ` (${p.url})` : ""}`);
        notes.newCtx = p.context;
      }
      if (prompt.done) {
        const p = await prompt.promise;
        notes.push(`A ${p.type} dialog opened: ${JSON.stringify(clipText(p.message, 120))}. Answer with zen-cli dialog accept|dismiss`);
      }
      return notes;
    } finally {
      for (const w of [started, loaded, created, prompt]) w.cancel();
    }
  }
}

function stale(key) { return new ZenError(`${key} is stale: the page changed since the last read. Read again.`); }
function clipText(s, n) { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Commands executed inside the helper
// ---------------------------------------------------------------------------

const VALUE_INPUTS = { date: "YYYY-MM-DD", time: "HH:MM (24-hour)", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", color: "#rrggbb", range: "a number" };
const SPECIAL_CHARS = { "\n": [SHIFT, ENTER], "\t": KEYS.tab };

export function normalizeUrl(u) {
  u = String(u).trim();
  if (/^[a-z][\w+.-]*:\/\//i.test(u) || /^(about|data|file|javascript|mailto|view-source|blob):/i.test(u)) return u;
  if (/^(localhost|127\.|\[?::1|\d+\.\d+\.\d+\.\d+)(:|\/|$)/i.test(u)) return "http://" + u;
  return "https://" + u;
}

export function sameUrl(a, b) {
  const n = s => { try { const u = new URL(s); return (u.origin + u.pathname).replace(/\/+$/, "") + u.search; } catch { return String(s).replace(/\/+$/, ""); } };
  return !!a && !!b && n(a) === n(b);
}

function where(t) {
  if (t.essential) return "Essentials";
  return [t.space, ...t.folder].filter(Boolean).join(" › ");
}

function tabLine(t) {
  const flags = [t.essential ? "essential" : t.pinned ? "pinned" : null, t.pending ? "unloaded" : null].filter(Boolean).join(", ");
  const loc = where(t);
  return `${t.id}${t.selected ? "*" : " "} ${clipText(t.title || "(untitled)", 60)} | ${clipText(t.url, 90)}${loc ? " | " + loc : ""}${flags ? " | " + flags : ""}`;
}

export function renderLayout(s, ids = true) {
  const lines = [];
  const name = t => clipText(t.title || t.url || "(untitled)", 60) + (ids && t.id ? ` (${t.id}${t.selected ? "*" : ""})` : "");
  const ess = s.tabs.filter(t => t.essential);
  if (ess.length) lines.push("Essentials: " + ess.map(name).join(" · "));
  const order = s.spaces.length ? s.spaces.map(x => x.name) : [...new Set(s.tabs.filter(t => !t.essential).map(t => t.space || "(no Space)"))];
  for (const sp of order) {
    const tabs = s.tabs.filter(t => !t.essential && (t.space || "(no Space)") === sp);
    lines.push(`${sp}${s.activeSpace === sp ? " (active)" : ""}${tabs.length ? "" : " (empty)"}`);
    const seen = new Set();
    for (const t of tabs.filter(t => t.pinned)) {
      t.folder.forEach((f, i) => {
        const p = t.folder.slice(0, i + 1).join("/");
        if (!seen.has(p)) { seen.add(p); lines.push("  ".repeat(i + 1) + f + "/"); }
      });
      lines.push("  ".repeat(t.folder.length + 1) + name(t));
    }
    const open = tabs.filter(t => !t.pinned);
    if (open.length) { lines.push("  open tabs:"); for (const t of open) lines.push("    " + name(t)); }
  }
  return lines.join("\n");
}

async function cmdTabs(b, a) {
  const s = await b.state();
  let tabs = s.tabs;
  if (a.flags.space) {
    const sp = s.spaces.find(x => x.name.toLowerCase() === a.flags.space.toLowerCase());
    if (b.sys && !sp) throw new ZenError(`No Space named "${a.flags.space}". Spaces: ${s.spaces.map(x => x.name).join(", ")}.`);
    tabs = tabs.filter(t => t.essential || t.space === sp?.name);
  } else if (!a.flags.all && s.activeSpace) tabs = tabs.filter(t => t.essential || t.space === s.activeSpace);
  const head = b.sys ? `Space: ${a.flags.space || (a.flags.all ? "all" : s.activeSpace)} (${s.spaces.map(x => x.name).join(", ")})` : "Loaded tabs (no system access: Spaces and unloaded tabs not visible)";
  return [head, ...tabs.map(tabLine)].join("\n");
}

async function cmdLayout(b) {
  if (!b.sys) return "\u0000no-sys";
  return renderLayout(await b.state());
}

async function cmdRead(b, a) {
  const section = a.pos.find(p => /^e\d+$/i.test(p));
  const tabArg = a.pos.find(p => /^t\d+$/i.test(p));
  const t = section ? null : await b.loadedTab(tabArg);
  const body = await b.read(t || { ctx: b.ref(section).top }, { section, mode: a.flags.full ? "full" : "compact", find: a.flags.find });
  const head = t ? `${t.id} ${clipText(t.title, 60)} | ${clipText(t.url, 90)}` : `${section} section`;
  return `${head}\n${body}`;
}

async function cmdText(b, a) {
  const t = await b.loadedTab(a.pos[0]);
  const max = Number(a.flags.max) || TEXT_CHARS;
  const [title, length, text] = await b.page(t.ctx, pageText, [max]);
  return `${t.id} ${clipText(title, 60)} | ${clipText(t.url, 90)}\n${text || "[no text]"}${length > max ? `\n[truncated: ${max} of ${length} characters; use --max]` : ""}`;
}

async function cmdShot(b, a) {
  const refArg = a.pos.find(p => /^e\d+$/i.test(p));
  let ctx, clip;
  if (refArg) {
    const { r } = await b.prepare(refArg);
    ctx = r.ctx;
    clip = { type: "element", element: { sharedId: r.sharedId } };
  } else ctx = (await b.loadedTab(a.pos.find(p => /^t\d+$/i.test(p)))).ctx;
  b.assertNoPrompt(ctx);
  const res = await b.call("browsingContext.captureScreenshot", { context: ctx, format: { type: "image/jpeg", quality: 0.8 }, ...(clip ? { clip } : {}) });
  mkdirSync(PATHS.shotsDir, { recursive: true });
  const file = join(PATHS.shotsDir, `shot-${Date.now()}.jpg`);
  writeFileSync(file, Buffer.from(res.data, "base64"));
  const old = readdirSync(PATHS.shotsDir).filter(f => f.startsWith("shot-")).sort().slice(0, -SHOTS_KEPT);
  for (const f of old) try { unlinkSync(join(PATHS.shotsDir, f)); } catch {}
  return `Saved ${file}`;
}

async function cmdOpen(b, a) {
  const raw = a.pos[0];
  if (!raw) throw new ZenError("Usage: zen-cli open <url> [--new] [--space <name>]");
  const url = normalizeUrl(raw);
  const s = await b.state();
  if (!a.flags.new && !a.flags.space) {
    const pinned = s.tabs.find(t => (t.pinned || t.essential) && sameUrl(t.url, url));
    if (pinned) {
      await b.activate(pinned);
      return `Switched to pinned tab ${pinned.id} (${where(pinned)}): ${clipText(pinned.title || url, 60)}`;
    }
  }
  let ctx, how;
  const current = s.tabs.find(t => t.selected);
  let final, loading;
  if (a.flags.space) {
    const r = await b.newTab(a.flags.space, url);
    const t = (await b.state()).tabs.find(x => x.key === r.key || (r.panel && x.panel === r.panel));
    if (t?.ctx) return `Opened ${clipText(url, 100)} in ${t.id}, a new tab in ${t.space}.`;
    return `Opened ${clipText(url, 100)} in ${t ? t.id : "a new tab"} in the ${a.flags.space} Space; it loads in the background and the user's view didn't move. Reading or acting on it needs zen-cli go ${t ? t.id : "<tab>"}, which switches to ${a.flags.space}.`;
  } else {
    if (a.flags.new || !current?.ctx || !b.own.has(current.ctx)) { ({ ctx } = await b.newTab(null)); how = a.flags.new || !current?.ctx ? "a new tab" : "a new tab, because the current tab isn't one zen-cli opened"; }
    else { ctx = current.ctx; how = "the current tab"; }
    ({ url: final, loading } = await b.navigate(ctx, url));
  }
  const t = (await b.state()).tabs.find(x => x.ctx === ctx);
  return `Opened ${clipText(final, 100)} in ${t ? t.id + ", " : ""}${how}${loading ? ". Still loading" : ""}.`;
}

async function cmdGo(b, a) {
  const t = await b.tab(a.pos[0] || "");
  const { loading } = await b.activate(t);
  const s = await b.state();
  const now = s.tabs.find(x => x.key === t.key) || t;
  return `Switched to ${now.id} ${clipText(now.title || "(untitled)", 60)} | ${clipText(now.url, 90)}${where(now) ? " | " + where(now) : ""}${loading ? " (still loading)" : ""}`;
}

async function cmdClose(b, a) {
  if (!a.pos[0]) throw new ZenError("Usage: zen-cli close <tab> [--force]");
  const t = await b.tab(a.pos[0]);
  if ((t.pinned || t.essential) && !a.flags.force) throw new ZenError(`${t.id} is ${t.essential ? "an Essential" : "a pinned tab"} in the user's layout. Closing removes it from the layout; pass --force only if the user asked.`);
  if (b.sys) { if (!(await b.chromeCall(chromeClose, t.key))) throw new ZenError(`${t.id} is already gone.`); }
  else await b.call("browsingContext.close", { context: t.ctx });
  if (t.ctx) b.dropRefs(t.ctx);
  return `Closed ${t.id} ${clipText(t.title, 60)}`;
}

async function cmdHistory(b, a, kind) {
  const t = await b.loadedTab(a.pos[0]);
  b.assertNoPrompt(t.ctx);
  const notes = await b.settle(t.ctx, async () => {
    if (kind === "reload") await b.call("browsingContext.reload", { context: t.ctx, wait: "none" });
    else await b.call("browsingContext.traverseHistory", { context: t.ctx, delta: kind === "back" ? -1 : 1 }).catch(e => { if (e.error === "no such history entry") throw new ZenError(`No ${kind} history in ${t.id}.`); throw e; });
  });
  b.dropRefs(t.ctx);
  return withNotes(`${kind === "reload" ? "Reloaded" : kind === "back" ? "Went back" : "Went forward"} in ${t.id}.`, notes);
}

function withNotes(msg, notes) { return notes.length ? `${msg} ${notes.join(". ")}.` : msg; }

async function cmdClick(b, a) {
  const key = a.pos[0];
  if (!key) throw new ZenError("Usage: zen-cli click eN");
  const { r, cover } = await b.prepare(key);
  let msg = `Clicked ${key}.`;
  if (cover) msg += ` Its center was covered by <${cover}>, which received the click.`;
  return withNotes(msg, await b.settle(r.top, () => b.click(r)));
}

async function cmdType(b, a) {
  const [key, text = ""] = a.pos;
  if (!key) throw new ZenError('Usage: zen-cli type eN "text" [--enter]');
  const { r, tag, kind } = await b.prepare(key);
  let msg;
  if (VALUE_INPUTS[kind]) {
    const v = await b.page(r.ctx, pageSetValue, [{ sharedId: r.sharedId }, text]);
    if (v === null) throw new ZenError(`${key} is disabled or read-only.`);
    if (text && !v) throw new ZenError(`"${text}" isn't a valid ${kind} value. Use ${VALUE_INPUTS[kind]}.`);
    msg = `Set ${key} to ${JSON.stringify(v)}.`;
  } else {
    if (tag === "SELECT") throw new ZenError(`${key} is a dropdown. Use zen-cli select ${key} "option".`);
    if (kind === "file") throw new ZenError(`${key} is a file input. Use zen-cli upload ${key} <file>.`);
    await b.click(r);
    await b.page(r.ctx, pageSelectContent, [{ sharedId: r.sharedId }]);
    await b.keys(r.ctx, text ? [...text].map(ch => SPECIAL_CHARS[ch] || ch) : [BACKSPACE]);
    msg = text ? `Typed ${[...text].length} characters into ${key}.` : `Cleared ${key}.`;
  }
  if (!a.flags.enter) return msg;
  return withNotes(msg + " Pressed Enter.", await b.settle(r.top, () => b.keys(r.ctx, [ENTER])));
}

async function cmdSelect(b, a) {
  const [key, wanted] = a.pos;
  if (!key || wanted === undefined) throw new ZenError('Usage: zen-cli select eN "option"');
  const { r } = await b.prepare(key);
  let status, info;
  const notes = await b.settle(r.top, async () => { [status, info] = await b.page(r.ctx, pageSelectOption, [{ sharedId: r.sharedId }, wanted]); });
  if (status === "not-select") throw new ZenError(`${key} isn't a native dropdown. Click it, read again, then click the option.`);
  if (status === "disabled") throw new ZenError(`${key} is disabled.`);
  if (status === "no-match") throw new ZenError(`No option matches "${wanted}". Options: ${info.map(o => JSON.stringify(o)).join(", ")}.`);
  return withNotes(`Selected ${JSON.stringify(info[0])} in ${key}.`, notes);
}

async function cmdUpload(b, a, cwd) {
  const [key, ...files] = a.pos;
  if (!key || !files.length) throw new ZenError("Usage: zen-cli upload eN <file> [file...]");
  const paths = files.map(f => resolvePath(cwd, f));
  for (const p of paths) if (!existsSync(p)) throw new ZenError(`No such file: ${p}`);
  const { r, kind } = await b.prepare(key);
  if (kind !== "file") throw new ZenError(`${key} isn't a file input. Read again and pick the input with role file.`);
  if (!b.sys) throw new ZenError("upload needs system access. Run zen-cli start --restart.");
  const { prev } = await b.chromeCall(chromeFilePref, true);
  try {
    await b.call("input.setFiles", { context: r.ctx, element: { sharedId: r.sharedId }, files: paths });
  } catch (e) {
    if (e.error === "unable to set file input") throw new ZenError(`${key} ${/multiple/.test(e.detail) ? "takes one file" : "can't take files"}: ${e.detail}`);
    throw e;
  } finally {
    await b.chromeCall(chromeFilePref, prev).catch(() => {});
  }
  return `Attached ${paths.length} file${paths.length > 1 ? "s" : ""} to ${key}.`;
}

async function cmdPress(b, a) {
  const spec = a.pos[0];
  if (!spec) throw new ZenError("Usage: zen-cli press <key> (e.g. Enter, Escape, Meta+L)");
  const t = await b.loadedTab(a.pos.find(p => /^t\d+$/i.test(p)));
  b.assertNoPrompt(t.ctx);
  const chord = parseChord(spec);
  return withNotes(`Pressed ${spec}.`, await b.settle(t.ctx, () => b.keys(t.ctx, [chord])));
}

async function cmdScroll(b, a) {
  const dir = (a.pos[0] || "down").toLowerCase();
  const amount = Number(a.pos.find(p => /^\d+$/.test(p))) || 600;
  const d = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] }[dir];
  if (!d) throw new ZenError("Usage: zen-cli scroll down|up|left|right [px]");
  const t = await b.loadedTab(a.pos.find(p => /^t\d+$/i.test(p)));
  const ctx = t.ctx;
  const [w, h] = await b.page(ctx, pageScrollInfo);
  const before = await b.page(ctx, pageScrollState);
  await b.actions(ctx, [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: Math.floor(w / 2), y: Math.floor(h / 2), deltaX: d[0], deltaY: d[1] }] }]);
  // Smooth scrolling takes a moment: wait until the position settles (max 2s).
  let state = before;
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const now = await b.page(ctx, pageScrollState);
    if (now === state && (now !== before || i >= 3)) break;
    state = now;
  }
  if (state === before) await b.page(ctx, pageScrollFallback, [d[0], d[1]]);
  else {
    // Wheel steps can stop short of large amounts; finish the rest directly.
    const [, , x1, y1] = await b.page(ctx, pageScrollInfo);
    const [x0, y0] = before.split(",").map(Number);
    const rest = [d[0] - (x1 - x0), d[1] - (y1 - y0)];
    if (Math.abs(rest[0]) > 2 || Math.abs(rest[1]) > 2) await b.page(ctx, pageScrollFallback, rest);
  }
  const [, vh, x, y, sw, sh] = await b.page(ctx, pageScrollInfo);
  if (`${x},${y}` === before.split(",").slice(0, 2).join(",") && state === before) return `Can't scroll ${dir}: already at the edge (y=${Math.round(y)} of ${Math.round(sh)}).`;
  return `Scrolled ${dir}. Viewport at y=${Math.round(y)} of ${Math.round(sh)} (height ${Math.round(vh)}), x=${Math.round(x)} of ${Math.round(sw)}.`;
}

async function cmdDialog(b, a) {
  const action = (a.pos[0] || "").toLowerCase();
  if (!["accept", "dismiss"].includes(action)) throw new ZenError('Usage: zen-cli dialog accept|dismiss ["text"]');
  const [ctx, p] = [...b.prompts.entries()][0] || [];
  if (!ctx) return "No dialog is open.";
  if (b.sys) {
    if (!(await b.chromeCall(chromeAnswer, ctx, action === "accept", a.pos[1] ?? null))) return "No dialog is open.";
  } else await b.call("browsingContext.handleUserPrompt", { context: ctx, accept: action === "accept", ...(a.pos[1] !== undefined ? { userText: a.pos[1] } : {}) });
  b.prompts.delete(ctx);
  return `${action === "accept" ? "Accepted" : "Dismissed"} the ${p.type} dialog ${JSON.stringify(clipText(p.message, 80))}.`;
}

async function cmdJs(b, a) {
  const code = a.pos[0];
  if (!code) throw new ZenError('Usage: zen-cli js "expression" [eN]  (with eN, code is a function taking the element)');
  const refArg = a.pos[1];
  let r;
  if (refArg) {
    const ref = b.ref(refArg);
    b.assertNoPrompt(ref.top);
    r = await b.call("script.callFunction", { functionDeclaration: code, target: { context: ref.ctx }, arguments: [{ sharedId: ref.sharedId }], awaitPromise: true, resultOwnership: "none", serializationOptions: { maxDomDepth: 0, maxObjectDepth: 4 } });
  } else {
    const t = await b.loadedTab(a.flags.tab);
    b.assertNoPrompt(t.ctx);
    r = await b.call("script.evaluate", { expression: code, target: { context: t.ctx }, awaitPromise: true, resultOwnership: "none", serializationOptions: { maxDomDepth: 0, maxObjectDepth: 4 } });
  }
  if (r.type === "exception") return `Error: ${r.exceptionDetails?.text || "exception"}`;
  const v = unwrap(r.result);
  const out = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return out === undefined ? "undefined" : out.length > 4000 ? out.slice(0, 4000) + `\n[truncated: ${out.length} characters]` : out;
}

async function helperStatus(b) {
  await b.ensure();
  const st = b.sys ? await b.chromeCall(chromeStatus) : null;
  return JSON.stringify({ sys: b.sys, ...st, pid: process.pid, rssMB: Math.round(process.memoryUsage().rss / 1048576), refs: b.refs.size });
}

const ACTIONS = { click: cmdClick, type: cmdType, select: cmdSelect, press: cmdPress, back: (b, a) => cmdHistory(b, a, "back"), forward: (b, a) => cmdHistory(b, a, "forward"), reload: (b, a) => cmdHistory(b, a, "reload"), open: cmdOpen, go: cmdGo, upload: cmdUpload, scroll: cmdScroll, dialog: cmdDialog };
const HELPER_COMMANDS = { tabs: cmdTabs, layout: cmdLayout, read: cmdRead, text: cmdText, shot: cmdShot, close: cmdClose, js: cmdJs, ...ACTIONS };

async function execute(b, req) {
  if (req.cmd === "__status") return helperStatus(b);
  await b.ensure();
  if (b.sys) { b.prompts.clear(); for (const p of await b.chromeCall(chromePrompts)) b.prompts.set(p.context, p); }
  const fn = HELPER_COMMANDS[req.cmd];
  let out = await fn(b, req.args, req.cwd);
  if (req.args.flags.read && ACTIONS[req.cmd] && req.cmd !== "dialog") {
    try {
      const s = await b.state();
      const t = s.tabs.find(x => x.ctx && x.ctx === b.lastCtx) || s.tabs.find(x => x.selected && x.ctx);
      if (t) out += "\n" + (await cmdRead(b, { pos: [t.id], flags: {} }));
    } catch (e) { out += `\n[read failed: ${e.message}]`; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper process: holds the one BiDi session; commands talk to it over a socket.
// ---------------------------------------------------------------------------

async function helperMain(port) {
  const sock = PATHS.socket(port);
  const log = PATHS.logFile(port);
  try { writeFileSync(log, `zen-cli helper ${process.pid} started ${new Date().toISOString()}\n`); } catch {}
  const note = m => { try { appendFileSync(log, `${new Date().toISOString()} ${m}\n`); } catch {} };
  if (!IS_WIN && existsSync(sock)) {
    if (await canConnect(sock)) process.exit(0);
    try { unlinkSync(sock); } catch {}
  }
  const browser = new Browser(port);
  let queue = Promise.resolve(), idle, stopping = false;
  const stop = async (why) => {
    if (stopping) return;
    stopping = true;
    note(`stopping: ${why}`);
    await browser.close();
    server.close();
    if (!IS_WIN) try { unlinkSync(sock); } catch {}
    process.exit(0);
  };
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => stop("idle"), IDLE_MS); };
  const server = net.createServer(conn => {
    let buf = "";
    conn.on("data", d => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { conn.end(JSON.stringify({ error: "bad request" }) + "\n"); return; }
      if (req.build !== BUILD) { conn.end(JSON.stringify({ restart: true }) + "\n"); stop("new build"); return; }
      clearTimeout(idle);
      queue = queue.then(async () => {
        let res;
        try { res = { ok: await execute(browser, req) }; }
        catch (e) {
          if (!(e instanceof ZenError)) note(`${req.cmd}: ${e.stack || e.message}`);
          res = { error: e instanceof ZenError ? e.message : `${e.message}` };
        }
        try { conn.end(JSON.stringify(res) + "\n"); } catch {}
        arm();
      });
    });
    conn.on("error", () => {});
  });
  server.on("error", e => { note(`listen: ${e.message}`); process.exit(0); });
  server.listen(sock, arm);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stop(sig));
  process.on("uncaughtException", e => { note(`uncaught: ${e.stack}`); stop("error"); });
  process.on("unhandledRejection", e => { note(`unhandled: ${e?.stack || e}`); });
}

function canConnect(target, timeout = 500) {
  return new Promise(res => {
    const c = net.connect(target);
    const t = setTimeout(() => { c.destroy(); res(false); }, timeout);
    c.on("connect", () => { clearTimeout(t); c.end(); res(true); });
    c.on("error", () => { clearTimeout(t); res(false); });
  });
}

function portOpen(port) { return canConnect({ host: "127.0.0.1", port }, 500); }

function askHelper(sock, req) {
  return new Promise((res, rej) => {
    const c = net.connect(sock);
    let buf = "";
    const t = setTimeout(() => { c.destroy(); rej(new ZenError("zen-cli helper timed out. Retry; if it persists, run zen-cli status.")); }, REQUEST_TIMEOUT_MS);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", d => { buf += d; });
    c.on("end", () => { clearTimeout(t); try { res(JSON.parse(buf)); } catch { rej(new ZenError("zen-cli helper sent a bad reply.")); } });
    c.on("error", e => { clearTimeout(t); rej(e); });
  });
}

async function request(port, cmd, args) {
  const sock = PATHS.socket(port);
  const req = { cmd, args, cwd: process.cwd(), build: BUILD };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await askHelper(sock, req);
      if (res.restart) { await sleep(200); continue; }
      return res;
    } catch (e) {
      if (e instanceof ZenError) throw e;
      if (!["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes(e.code)) throw e;
      spawn(process.execPath, [SELF, "__helper", String(port)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      const end = Date.now() + 5000;
      while (Date.now() < end && !(await canConnect(sock, 200))) await sleep(50);
    }
  }
  throw new ZenError("Couldn't start the zen-cli helper. Run zen-cli status.");
}

// ---------------------------------------------------------------------------
// Commands executed in the CLI process
// ---------------------------------------------------------------------------

function profileLabel(p) { return p.name === p.path ? p.path : `${p.name} (${p.path})`; }

function skillSource() { return join(dirname(SELF), "..", "skills", "zen-cli", "SKILL.md"); }
function skillTarget(env = process.env) { return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills", "zen-cli", "SKILL.md"); }

async function cmdSetup(a) {
  const profile = resolveProfile(a.flags.profile || process.env.ZEN_CLI_PROFILE);
  const lines = [`Profile: ${profileLabel(profile)}`];
  const userJs = join(profile.path, "user.js");
  if (hasSafetyPref(profile.path)) lines.push(`Safety pref: already set in ${userJs}`);
  else {
    appendFileSync(userJs, `\n// zen-cli: keep Safe Browsing and the popup blocker on while remote control runs.\nuser_pref("${SAFETY_PREF}", false);\n`);
    lines.push(`Safety pref: added to ${userJs}${(await zenHolder(profile.path)) ? " (takes effect when Zen next starts)" : ""}`);
  }
  // Until Zen's welcome screen is dismissed, pages get a 0x0 viewport and clicks miss.
  const prefsJs = (() => { try { return readFileSync(join(profile.path, "prefs.js"), "utf8") + readFileSync(userJs, "utf8"); } catch { return readFileSync(userJs, "utf8"); } })();
  if (!/user_pref\(\s*"zen\.welcome-screen\.seen"\s*,\s*true\s*\)/.test(prefsJs)) {
    appendFileSync(userJs, `// zen-cli: skip Zen's welcome screen; pages have no size until it's dismissed.\nuser_pref("zen.welcome-screen.seen", true);\n`);
    lines.push("Welcome screen: marked as seen");
  }
  const src = skillSource(), dst = skillTarget();
  if (!existsSync(src)) lines.push(`Claude Code skill: source missing at ${src}`);
  else if (existsSync(dst) && readFileSync(dst, "utf8") === readFileSync(src, "utf8")) lines.push(`Claude Code skill: up to date at ${dst}`);
  else { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); lines.push(`Claude Code skill: installed at ${dst}`); }
  return lines.join("\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  process.stdout.write(`${question} [y/N] `);
  return new Promise(res => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", d => { process.stdin.pause(); res(/^y(es)?$/i.test(String(d).trim())); });
  });
}

async function cmdStart(a, port) {
  const profile = resolveProfile(a.flags.profile || process.env.ZEN_CLI_PROFILE);
  const zen = await findZen();
  if (!hasSafetyPref(profile.path)) throw new ZenError("The safety pref isn't set in this profile. Run zen-cli setup first.");
  let reason = null;
  if (await portOpen(port)) {
    const res = await request(port, "__status", { pos: [], flags: {} });
    if (res.ok) {
      const st = JSON.parse(res.ok);
      if (st.sys) return `Zen is ready on port ${port} (system access on).`;
      reason = "Zen is running with remote control but without system access, so Spaces and unloaded tabs aren't visible.";
    } else if (/stuck automation session/.test(res.error)) reason = "Zen has a stuck automation session.";
    else throw new ZenError(res.error);
  } else if (await zenHolder(profile.path)) reason = "Zen is open without remote control.";

  if (reason) {
    const why = `${reason} Restarting Zen keeps tabs and Spaces but loses unsaved page state (half-filled forms).`;
    if (!a.flags.restart && !(await confirm(`${why} Restart now?`))) {
      return `${why}\nAsk the user, then run: zen-cli start --restart`;
    }
    const pid = await zenHolder(profile.path);
    if (pid) await quitZen(pid, profile.path);
    const end = Date.now() + 10_000;
    while ((await portOpen(port)) && Date.now() < end) await sleep(200);
  }
  launchZen(zen, profile.path, port);
  const end = Date.now() + 30_000;
  while (!(await portOpen(port))) {
    if (Date.now() > end) throw new ZenError(`Started Zen, but nothing listens on port ${port} after 30s. Run zen-cli status.`);
    await sleep(250);
  }
  // The browser window appears shortly after the port opens.
  let st = null;
  for (let i = 0; i < 20 && !st?.sys; i++) {
    const res = await request(port, "__status", { pos: [], flags: {} });
    st = res.ok ? JSON.parse(res.ok) : null;
    if (!st?.sys) await sleep(300);
  }
  return `${reason ? "Restarted" : "Started"} Zen on port ${port}${st?.sys ? " with system access" : " (system access not available)"}. Profile: ${profileLabel(profile)}.`;
}

async function cmdStatus(a, port) {
  const lines = [];
  let zen = null, profile = null;
  try { zen = await findZen(); lines.push(`Zen: ${zen.app || zen.bin}`); } catch (e) { lines.push(`Zen: not found. ${e.message}`); }
  try {
    profile = resolveProfile(a.flags.profile || process.env.ZEN_CLI_PROFILE);
    lines.push(`Profile: ${profileLabel(profile)}`);
    lines.push(`Safety pref: ${hasSafetyPref(profile.path) ? "set" : "missing; run zen-cli setup"}`);
  } catch (e) { lines.push(`Profile: ${e.message}`); }
  lines.push(`Skill: ${existsSync(skillTarget()) ? "installed" : "not installed; run zen-cli setup"}`);
  if (!(await portOpen(port))) {
    const open = profile && (await zenHolder(profile.path));
    lines.push(`Remote control: off (port ${port})${open ? "; Zen is open without it" : ""}. Run zen-cli start.`);
    return lines.join("\n");
  }
  const res = await request(port, "__status", { pos: [], flags: {} });
  if (res.error) { lines.push(`Remote control: port ${port} open, but ${res.error}`); return lines.join("\n"); }
  const st = JSON.parse(res.ok);
  lines.push(`Remote control: on (port ${port}), system access ${st.sys ? "on" : "off"}${st.version ? `, Zen ${st.version}` : ""}`);
  if (st.sys) lines.push(`Safe Browsing: ${st.safeBrowsing ? "on" : "OFF"}, popup blocker: ${st.popupBlocker ? "on" : "OFF"}${st.fileInChild ? ", dom.file.createInChild is on" : ""}`);
  lines.push(`Helper: pid ${st.pid}, ${st.rssMB} MB, exits after 10 idle minutes`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Help and guide
// ---------------------------------------------------------------------------

const HELP = `zen-cli: read and drive the Zen browser

See:      tabs [--all] [--space S] | layout | read [tN|eN] [--full] [--find T] | text [tN] [--max N] | shot [tN|eN]
Act:      open <url> [--new] [--space S] | go tN | close tN [--force] | back | forward | reload
          click eN | type eN "text" [--enter] | select eN "option" | upload eN <file...> | press <key>
          scroll down|up|left|right [px] | dialog accept|dismiss ["text"] | js "code" [eN]
          --read on any action appends the new page outline
Manage:   setup | start [--restart] | status | guide | help
Options:  --profile <name|path>, --port <n> (or ZEN_CLI_PROFILE, ZEN_CLI_PORT, ZEN_CLI_APP)`;

const GUIDE = `zen-cli drives the user's own Zen browser. Work in a loop: look, act, check.

Start
- zen-cli status. If remote control is off, zen-cli start.
- If start says Zen must restart, ask the user first (unsaved page state is lost), then zen-cli start --restart.

Look
- tabs: tabs in the active Space plus Essentials; --all for every Space. * marks the selected tab. Unloaded tabs need go before reading.
- layout: Spaces, Essentials, folders and pinned tabs.
- read [tN]: compact outline of the page: headings, sections, status messages, and interactive elements with refs (e12) and state (checked, expanded, value). Defaults to the selected tab.
  Keep reads small: read --find "Sign in" shows elements whose label contains the text (case-insensitive; link targets only match when the text has / or .), with their parent sections. read e40 shows one section. --full adds page text and untruncated labels. Use text for articles or anything still cut off.
- shot only when visuals matter; images cost far more than text. It saves a JPEG and prints the path.

Act
- click e12 | type e5 "text" --enter | select e7 "Option" | upload e9 ./file.pdf | press Enter | scroll down
- Every action prints its outcome: navigation, new tab, covered element, or dialog. Add --read to get the new outline in the same call; after a submit, check the status line or use text.
- open <url>: switches to a matching pinned tab. Otherwise it reuses the current tab only if zen-cli opened it, else opens and selects a new tab. --new forces a new tab; --space Work adds one there without moving the user's view (go to it before acting).
- go tN switches (and loads) a tab. back, forward, reload.

Refs
- Refs come from the latest read of a tab and stay valid until that tab is read again or navigates. Numbers keep counting up. A stale ref means the page changed: read again.

Dialogs
- If a command reports a dialog (alert, confirm, prompt, leave page), answer it: dialog accept|dismiss ["text"].

Escape hatch
- js "document.title" runs in the page. js "el => el.value" e5 runs with an element.

Respect the user's browser
- Prefer tabs you opened. Don't navigate or close the user's pinned tabs or Essentials; close needs --force for those, only when asked.
- Don't change browser settings.
- On macOS, uploading from Documents, Desktop or Downloads can make macOS ask the user to let Zen access that folder; Zen freezes until they answer. Prefer files in other folders, or tell the user to expect the prompt.

Errors are one line and say what to do next. Follow them.`;

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["space", "find", "profile", "port", "max", "tab"]);

export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith("--") && s.length > 2) {
      const [k, v] = s.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (VALUE_FLAGS.has(k)) { if (i + 1 >= argv.length) throw new ZenError(`--${k} needs a value.`); flags[k] = argv[++i]; }
      else flags[k] = true;
    } else pos.push(s);
  }
  return { pos, flags };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "__helper") return helperMain(Number(rest[0]) || DEFAULT_PORT);
  const a = parseArgs(rest);
  const port = Number(a.flags.port || process.env.ZEN_CLI_PORT) || DEFAULT_PORT;
  let out;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") out = HELP;
  else if (cmd === "guide") out = GUIDE;
  else if (cmd === "--version" || cmd === "version") out = JSON.parse(readFileSync(join(dirname(SELF), "..", "package.json"), "utf8")).version;
  else if (cmd === "setup") out = await cmdSetup(a);
  else if (cmd === "start") out = await cmdStart(a, port);
  else if (cmd === "status") out = await cmdStatus(a, port);
  else if (cmd === "layout" && !(await portOpen(port))) {
    out = "Zen isn't running with remote control; layout from the saved session file:\n" + renderLayout(readSessionFile(resolveProfile(a.flags.profile || process.env.ZEN_CLI_PROFILE).path), false);
  } else if (HELPER_COMMANDS[cmd]) {
    const res = await request(port, cmd, a);
    if (res.error) throw new ZenError(res.error);
    out = res.ok;
    if (out === "\u0000no-sys") out = "No system access, so this is the layout from the saved session file (run zen-cli start --restart for live state):\n" + renderLayout(readSessionFile(resolveProfile(a.flags.profile || process.env.ZEN_CLI_PROFILE).path), false);
  } else throw new ZenError(`Unknown command "${cmd}". Run zen-cli help.`);
  process.stdout.write(out + "\n");
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === SELF; } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2)).catch(e => {
    process.stderr.write((e instanceof ZenError ? e.message : `zen-cli failed: ${e.message}`) + "\n");
    process.exit(1);
  });
}
