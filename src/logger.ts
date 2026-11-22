type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: object): void;
  info(msg: string, extra?: object): void;
  warn(msg: string, extra?: object): void;
  error(msg: string, extra?: object): void;
}

export function createLogger(level: Level = "info", now: () => number = Date.now): Logger {
  const log = (l: Level, msg: string, extra?: object) => {
    if (order[l] < order[level]) return;
    const ts = new Date(now()).toISOString();
    const line = `${ts} ${l.toUpperCase().padEnd(5)} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
    (l === "error" || l === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, e) => log("debug", m, e),
    info: (m, e) => log("info", m, e),
    warn: (m, e) => log("warn", m, e),
    error: (m, e) => log("error", m, e),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
