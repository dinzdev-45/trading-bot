import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/bot.js";
import { DashboardHub } from "../src/dashboard/hub.js";
import { startDashboard } from "../src/dashboard/server.js";
import { PaperExecutor } from "../src/exec/paper.js";
import { Journal } from "../src/journal.js";
import { silentLogger } from "../src/logger.js";
import { testConfig } from "./helpers.js";

function get(port: number, path: string, host = `localhost:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, path, host: "127.0.0.1", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("dashboard serves page + snapshot, loads journal history, hides secrets, rejects foreign Host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  const path = join(dir, "trades-paper.jsonl");
  writeFileSync(path, JSON.stringify({ t: 1, type: "close", mint: "m", symbol: "OLD", pnlSol: 0.05 }) + "\nnot json\n");
  const cfg = testConfig({ WALLET_PRIVATE_KEY: "SECRETKEY123", RPC_URL: "https://rpc.example/?api-key=SECRETRPC" });
  const journal = new Journal(path);
  const bot = new Bot({
    cfg,
    log: silentLogger,
    executor: new PaperExecutor(cfg),
    journal,
    subscribe: () => {},
    unsubscribe: () => {},
    fetchSocials: async () => null,
  });
  const hub = new DashboardHub(cfg);
  hub.attach(bot, journal, { connected: true });
  journal.write({ t: 2, type: "buy", mint: "n", symbol: "NEW", sol: 0.1 });
  const srv = await startDashboard(hub, "127.0.0.1", 0);
  try {
    const page = await get(srv.port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /Momentum Bot/);

    const snap = await get(srv.port, "/api/snapshot");
    assert.equal(snap.status, 200);
    assert.doesNotMatch(snap.body, /SECRET/);
    const data = JSON.parse(snap.body);
    assert.deepEqual(data.trades.map((t: { symbol: string }) => t.symbol), ["OLD", "NEW"]);
    assert.equal(data.state.summary.balanceSol, cfg.STARTING_BALANCE_SOL);
    assert.equal(data.state.feed.connected, true);
    assert.equal(data.equity.length, 1);

    assert.equal((await get(srv.port, "/", "evil.example:80")).status, 403);
    assert.equal((await get(srv.port, "/nope")).status, 404);
  } finally {
    hub.stop();
    await srv.close();
  }
});
