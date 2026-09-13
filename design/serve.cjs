const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};
http
  .createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400);
      return res.end("Bad request");
    }
    const file = path.resolve(
      root,
      "." + pathname + (pathname.endsWith("/") ? "index.html" : ""),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
    });
  })
  .listen(4174, "127.0.0.1", () =>
    console.log("Muse-Desktop design: http://127.0.0.1:4174/"),
  );
