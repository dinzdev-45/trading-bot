import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DashboardHub } from "./hub.js";

const PAGE = new URL("./public/index.html", import.meta.url);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export interface DashboardServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Read-only HTTP server for the dashboard:
 *   GET /               the page
 *   GET /api/snapshot   full state (equity curve, trades, logs)
 *   GET /api/stream     Server-Sent Events: state (1s), equity, trade, log
 * When bound to loopback, requests with a foreign Host header are refused (blocks DNS rebinding).
 */
export async function startDashboard(hub: DashboardHub, host: string, port: number, triesLeft = 10): Promise<DashboardServer> {
  const html = readFileSync(PAGE);
  const loopbackOnly = LOOPBACK.has(host);
  const server = createServer((req, res) => handle(req, res));

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (loopbackOnly && !LOOPBACK.has(hostname(req.headers.host))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    const secure = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { ...secure, "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" }).end(html);
      return;
    }
    if (path === "/api/snapshot") {
      res.writeHead(200, { ...secure, "Content-Type": "application/json" }).end(JSON.stringify(hub.snapshot()));
      return;
    }
    if (path === "/api/stream") {
      res.writeHead(200, { ...secure, "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(": connected\n\n");
      const off = hub.subscribe((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      req.on("close", off);
      return;
    }
    res.writeHead(404, secure).end("not found");
  }

  try {
    await listen(server, host, port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== 0 && triesLeft > 0) {
      return startDashboard(hub, host, port + 1, triesLeft - 1);
    }
    throw e;
  }
  const actual = (server.address() as AddressInfo).port;
  const shown = loopbackOnly ? "localhost" : host;
  return {
    url: `http://${shown}:${actual}`,
    port: actual,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function hostname(header: string | undefined): string {
  if (!header) return "";
  if (header.startsWith("[")) return header.slice(1, header.indexOf("]"));
  return header.split(":")[0]!.toLowerCase();
}
