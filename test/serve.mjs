// Serves test/fixtures on two local ports so the fixture can embed a cross-origin frame.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain" };

export function serve(port) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "page.html";
    if (path === "slow") { setTimeout(() => res.writeHead(200, { "content-type": TYPES[".html"] }).end("<title>Slow</title><h1>Slow page</h1>"), 4000); return; }
    try {
      const body = await readFile(join(DIR, path.replace(/\.\./g, "")));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise(r => server.listen(port, "127.0.0.1", () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [a = 8401, b = 8402] = process.argv.slice(2).map(Number);
  await serve(a);
  await serve(b);
  console.log(`fixtures on http://127.0.0.1:${a}/ and http://127.0.0.1:${b}/`);
}
