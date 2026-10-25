// Unit tests: no Zen needed. Run with `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtemp, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  platformPaths, parseIni, listProfiles, resolveProfile, hasSafetyPref, mozlz4Decode, layoutFromSession,
  renderOutline, renderLayout, parseChord, parseArgs, normalizeUrl, sameUrl, launchArgs, unwrap,
} from "../bin/zen-cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps = [];
const mkdtempSync = prefix => { const d = mkdtemp(prefix); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// Literal-only LZ4 block: valid mozlz4 without a compressor.
function mozlz4Encode(buf) {
  const n = buf.length, head = [];
  if (n < 15) head.push(n << 4);
  else { head.push(0xf0); let r = n - 15; while (r >= 255) { head.push(255); r -= 255; } head.push(r); }
  const size = Buffer.alloc(4); size.writeUInt32LE(n);
  return Buffer.concat([Buffer.from("mozLz40\0", "latin1"), size, Buffer.from(head), buf]);
}

test("platform paths: macOS", () => {
  const p = platformPaths("darwin", {}, "/Users/u", "/tmp", "u");
  assert.equal(p.zenRoot, "/Users/u/Library/Application Support/zen");
  assert.deepEqual(p.appCandidates, ["/Applications/Zen.app", "/Users/u/Applications/Zen.app"]);
  assert.equal(p.socket(9333), "/tmp/zen-cli-9333.sock");
});

test("platform paths: Windows", () => {
  const env = { APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
  const p = platformPaths("win32", env, "C:\\Users\\u", "C:\\Temp", "u");
  assert.match(p.zenRoot, /Roaming.zen$/);
  assert.ok(p.appCandidates.some(c => /Program Files.Zen Browser.zen\.exe$/.test(c)));
  assert.ok(p.appCandidates.some(c => /Local.Programs.Zen Browser.zen\.exe$/.test(c)));
  assert.equal(p.socket(9333), "\\\\.\\pipe\\zen-cli-u-9333");
});

test("ini parsing and profile resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "zen-cli-test-"));
  for (const d of ["Profiles/aaa.Default (release)", "Profiles/bbb.Other"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "profiles.ini"), "[General]\nVersion=2\n\n[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/aaa.Default (release)\n\n[Profile1]\nName=Other\nIsRelative=1\nPath=Profiles/bbb.Other\nDefault=1\n");
  writeFileSync(join(root, "installs.ini"), "[ABC123]\r\nDefault=Profiles/aaa.Default (release)\r\nLocked=1\r\n");
  assert.equal(parseIni("[A]\nk = v\n;c\n").A.k, "v");
  assert.equal(listProfiles(root).length, 2);
  assert.equal(resolveProfile(null, root).name, "Default (release)");
  assert.equal(resolveProfile("Other", root).path, join(root, "Profiles", "bbb.Other"));
  assert.equal(resolveProfile(join(root, "Profiles", "bbb.Other"), root).name, "Other");
  assert.throws(() => resolveProfile("Nope", root), /No Zen profile named "Nope"/);
});

test("safety pref detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "zen-cli-test-"));
  assert.equal(hasSafetyPref(dir), false);
  writeFileSync(join(dir, "user.js"), 'user_pref("remote.prefs.recommended", true);\n');
  assert.equal(hasSafetyPref(dir), false);
  writeFileSync(join(dir, "user.js"), 'user_pref( "remote.prefs.recommended",false );\n');
  assert.equal(hasSafetyPref(dir), true);
});

test("mozlz4 decode with and without back-references", () => {
  const text = Buffer.from(JSON.stringify({ hello: "world".repeat(10) }));
  assert.equal(mozlz4Decode(mozlz4Encode(text)).toString(), text.toString());
  // "abcabcabcabc": 3 literals, then a 9-byte match at offset 3
  const block = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]);
  const size = Buffer.alloc(4); size.writeUInt32LE(12);
  assert.equal(mozlz4Decode(Buffer.concat([Buffer.from("mozLz40\0", "latin1"), size, block])).toString(), "abcabcabcabc");
  assert.throws(() => mozlz4Decode(Buffer.from("nope")), /mozlz4/);
});

test("session file layout", () => {
  const data = {
    spaces: [{ uuid: "s1", name: "Home" }, { uuid: "s2", name: "Work" }],
    folders: [{ id: "f1", name: "Lab", parentId: null }, { id: "f2", name: "Sub", parentId: "f1" }],
    tabs: [
      { zenSyncId: "a", pinned: true, zenEssential: true, entries: [{ url: "https://mail.example/", title: "Mail" }] },
      { zenSyncId: "b", pinned: true, zenWorkspace: "s1", groupId: "f2", _zenPinnedInitialState: { entry: { url: "https://lab.example/", title: "Lab app" } }, entries: [] },
      { zenSyncId: "c", pinned: true, zenWorkspace: "s1", groupId: "f2", zenIsEmpty: true, entries: [{ url: "about:blank" }] },
      { zenSyncId: "d", pinned: false, zenWorkspace: "s2", entries: [{ url: "https://news.example/", title: "News" }], index: 1 },
    ],
  };
  const s = layoutFromSession(data);
  assert.equal(s.tabs.length, 3);
  assert.deepEqual(s.tabs[1].folder, ["Lab", "Sub"]);
  const out = renderLayout(s, false);
  assert.match(out, /^Essentials: Mail$/m);
  assert.match(out, /^Home\n  Lab\/\n    Sub\/\n      Lab app$/m);
  assert.match(out, /^Work\n  open tabs:\n    News$/m);
});

test("outline: compact drops text and empty sections, find keeps ancestors", () => {
  const items = [
    { depth: 0, line: "main", ref: "e1", section: true },
    { depth: 1, line: 'h1 "Title"' },
    { depth: 1, line: '"Some prose"' },
    { depth: 1, line: "form", ref: "e2", section: true },
    { depth: 2, line: 'textbox "Email"', ref: "e3" },
    { depth: 2, line: 'button "Sign in"', ref: "e4" },
    { depth: 1, line: 'status "Saved!"' },
    { depth: 0, line: "footer", ref: "e5", section: true },
    { depth: 1, line: '"© 2026"' },
  ];
  const compact = renderOutline(items);
  assert.ok(!compact.includes("Some prose"));
  assert.ok(!compact.includes("footer"));
  assert.ok(compact.includes('e4 button "Sign in"'));
  assert.ok(compact.includes('status "Saved!"'));
  assert.ok(renderOutline(items, { mode: "full" }).includes("Some prose"));
  const found = renderOutline(items, { find: "sign" });
  assert.equal(found, 'e1 main\n  e2 form\n    e4 button "Sign in"');
  assert.match(renderOutline(items, { find: "zzz" }), /nothing matches/);
});

test("outline: truncation note and compact link targets", () => {
  const items = Array.from({ length: 400 }, (_, i) => ({ depth: 0, line: `link "Item ${i}" -> example.com/a/very/long/path/that/goes/on/and/on/${i}`, ref: `e${i}` }));
  const out = renderOutline(items);
  assert.ok(out.length <= 5_600);
  assert.match(out, /\[truncated: showing \d+ of 400 lines/);
  assert.match(out, /-> .{40}…$/m);
});

test("key chords", () => {
  assert.deepEqual(parseChord("Enter"), ["\uE007"]);
  assert.deepEqual(parseChord("Meta+L"), ["\uE03D", "l"]);
  assert.deepEqual(parseChord("A"), ["A"]);
  assert.throws(() => parseChord("Hyper+Q"), /Unknown key "Hyper"/);
});

test("argument parsing", () => {
  assert.deepEqual(parseArgs(["e5", "hi there", "--enter", "--space", "Work"]), { pos: ["e5", "hi there"], flags: { enter: true, space: "Work" } });
  assert.deepEqual(parseArgs(["--find=Sign in"]), { pos: [], flags: { find: "Sign in" } });
  assert.throws(() => parseArgs(["--space"]), /needs a value/);
});

test("urls", () => {
  assert.equal(normalizeUrl("github.com"), "https://github.com");
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("192.168.0.1"), "http://192.168.0.1");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.ok(sameUrl("https://github.com/", "https://github.com"));
  assert.ok(!sameUrl("https://github.com/a", "https://github.com/b"));
});

test("launch args and BiDi value unwrapping", () => {
  assert.deepEqual(launchArgs("/p", 9333), ["--profile", "/p", "--remote-debugging-port", "9333", "--remote-allow-system-access"]);
  assert.deepEqual(unwrap({ type: "array", value: [{ type: "string", value: "a" }, { type: "number", value: 2 }, { type: "null" }] }), ["a", 2, null]);
  assert.deepEqual(unwrap({ type: "object", value: [["k", { type: "boolean", value: true }]] }), { k: true });
  assert.deepEqual(unwrap({ type: "node", sharedId: "x" }), { sharedId: "x" });
});

test("no personal paths or user names in shipped files", () => {
  const files = ["bin/zen-cli.mjs", "skills/zen-cli/SKILL.md"].map(f => join(ROOT, f));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /\/Users\/[a-z]|C:\\\\Users\\\\[a-z]|exlcqnob|nesh\.studio/i, f);
  }
});

test("skill stays small", () => {
  const skill = readFileSync(join(ROOT, "skills", "zen-cli", "SKILL.md"), "utf8");
  const description = skill.match(/^description: (.+)$/m)[1];
  assert.ok(description.length / 4 <= 50, `description ~${Math.round(description.length / 4)} tokens`);
});
