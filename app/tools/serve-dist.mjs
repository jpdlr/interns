/** Static server for dist/: assets as-is, deep links get their route's own page (see page-route.mjs). */
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { notFoundPage, resolvePage } from "./page-route.mjs";

const root = process.argv[2];
const port = Number(process.argv[3] ?? 7812);
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".map": "application/json" };

http.createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const asset = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  const page = resolvePage(root, req.url);
  const [file, status] =
    existsSync(asset) && statSync(asset).isFile() ? [asset, 200] : page ? [join(root, page), 200] : [join(root, notFoundPage(root)), 404];
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(status, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`static on ${port}`));
