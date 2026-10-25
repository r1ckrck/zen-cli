// End-to-end tests against a real Zen in a throwaway profile.
// Opt in with ZEN_CLI_E2E=1 npm test. Zen must be installed; the user's own profile is never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { zenHolder, quitZen } from "../bin/zen-cli.mjs";

const RUN = process.env.ZEN_CLI_E2E === "1";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "zen-cli.mjs");
const PORT = 9555;
const dir = RUN ? mkdtempSync(join(tmpdir(), "zen-cli-e2e-")) : "";
const profile = join(dir, "profile");
const env = { ...process.env, ZEN_CLI_PROFILE: profile, ZEN_CLI_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(dir, "claude") };
let servers = [];

function zen(...args) {
  return new Promise(res => execFile(process.execPath, [CLI, ...args], { env, timeout: 90_000 }, (err, stdout, stderr) => res({ code: err ? err.code ?? 1 : 0, out: (stdout + stderr).trim() })));
}
async function ok(...args) {
  const r = await zen(...args);
  assert.equal(r.code, 0, `zen-cli ${args.join(" ")} failed: ${r.out}`);
  return r.out;
}
function ref(outline, pattern) {
  const line = outline.split("\n").find(l => /^\s*e\d+ /.test(l) && pattern.test(l));
  assert.ok(line, `no element matching ${pattern} in:\n${outline}`);
  return line.trim().split(" ")[0];
}

before(async () => {
  if (!RUN) return;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "user.js"), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.warnOnQuit", false);\n');
  servers = [await serve(8501), await serve(8502)];
});

after(async () => {
  if (!RUN) return;
  const pid = await zenHolder(profile);
  if (pid) await quitZen(pid, profile);
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

test("full flow", { skip: !RUN && "set ZEN_CLI_E2E=1 to run against a real Zen", timeout: 300_000 }, async () => {
  assert.match((await zen("start")).out, /Run zen-cli setup first/);
  assert.match(await ok("setup"), /Safety pref: added/);
  assert.match(await ok("setup"), /Safety pref: already set/);
  assert.match(await ok("start"), /Started Zen on port 9555 with system access/);
  assert.match(await ok("status"), /Safe Browsing: on, popup blocker: on/);

  assert.match(await ok("open", "http://127.0.0.1:8501/page.html?xo=http://127.0.0.1:8502/page2.html", "--new"), /Opened .* in t\d+/);
  assert.ok((await ok("read", "--full")).includes("plain text that compact reads"));
  // Each read of a tab replaces its refs, so act on the latest one.
  let r = await ok("read");
  for (const s of ['textbox "Name"', 'button "Shadow button"', 'button "Frame button"', 'button "Cross button"', 'clickable "Fake button"', "checkbox \"Notifications\" unchecked"]) assert.ok(r.includes(s), s);
  assert.ok(!r.includes("plain text that compact reads"));

  await ok("type", ref(r, /textbox "Name"/), "Ada", "--enter");
  await ok("type", ref(r, /"Birthday"/), "2026-01-02");
  await ok("click", ref(r, /checkbox "Notifications"/));
  await ok("select", ref(r, /select "Country"/), "Netherlands");
  const avatar = join(dir, "avatar.txt");
  writeFileSync(avatar, "hi");
  await ok("upload", ref(r, /file "Avatar"/), avatar);
  await ok("click", ref(r, /"Fake button"/));
  await ok("click", ref(r, /"Shadow button"/));
  await ok("click", ref(r, /"Frame button"/));
  const clicked = await ok("click", ref(r, /button "Confirm"/));
  if (!/confirm dialog opened/.test(clicked)) assert.fail(`${clicked}\nlogs: ${(await zen("js", "logs.join('|')")).out}\nstatus: ${(await zen("status")).out}\ntabs: ${(await zen("tabs")).out}`);
  assert.match((await zen("read")).out, /dialog is open/);
  assert.match(await ok("dialog", "accept"), /Accepted the confirm dialog/);
  const state = JSON.parse(await ok("js", "JSON.stringify({ logs, file: document.getElementById('avatar').files[0]?.name, bday: document.querySelector('[name=bday]').value, country: document.querySelector('[name=country]').value })"));
  assert.deepEqual(state, { logs: ["submitted:Ada", "notify:true", "fake-click", "shadow-click", "frame-click", "confirm:true"], file: "avatar.txt", bday: "2026-01-02", country: "nl" });

  r = await ok("read");
  assert.match(await ok("click", ref(r, /link "Go to page two"/), "--read"), /Page navigated to .*page2\.html[\s\S]*h1 "Page two"/);
  assert.match(await ok("back"), /Went back/);
  assert.match(await ok("scroll", "down", "1000"), /Scrolled down\. Viewport at y=1000/);
  assert.match(await ok("shot"), /Saved .*\.jpg/);
  assert.match(await ok("tabs"), /\* zen-cli test page/);
  assert.match(await ok("layout"), /\(active\)/);
});
