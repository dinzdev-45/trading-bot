import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "../logger.js";

/**
 * PumpPortal data WebSocket with auto-reconnect.
 * Emits "message" (parsed JSON) for every data message.
 * Keeps ONE connection, as PumpPortal asks; token subscriptions are restored after reconnect.
 */
export class PumpPortalFeed extends EventEmitter {
  private ws?: WebSocket;
  private readonly tradeKeys = new Set<string>();
  private closed = false;
  private backoffMs = 1000;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {
    super();
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  subscribeTrades(mints: string[]): void {
    const fresh = mints.filter((m) => !this.tradeKeys.has(m));
    fresh.forEach((m) => this.tradeKeys.add(m));
    if (fresh.length) this.send({ method: "subscribeTokenTrade", keys: fresh });
  }

  unsubscribeTrades(mints: string[]): void {
    const known = mints.filter((m) => this.tradeKeys.delete(m));
    if (known.length) this.send({ method: "unsubscribeTokenTrade", keys: known });
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private connect(): void {
    this.log.info(`connecting to ${this.url.replace(/api-key=[^&]+/, "api-key=***")}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.log.info("feed connected");
      this.send({ method: "subscribeNewToken" });
      this.send({ method: "subscribeMigration" });
      if (this.tradeKeys.size) this.send({ method: "subscribeTokenTrade", keys: [...this.tradeKeys] });
      this.emit("open");
    });
    ws.on("message", (data) => {
      try {
        this.emit("message", JSON.parse(data.toString()));
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on("error", (err) => this.log.warn(`feed error: ${err.message}`));
    ws.on("close", () => {
      if (this.closed) return;
      this.log.warn(`feed disconnected, reconnecting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }
}
