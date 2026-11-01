import fs from "node:fs";
import path from "node:path";
import { redactDeep, redactSecrets, nowIso } from "./text.js";

export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

const COLORS: Record<LogLevel, string> = {
  debug: "\u001b[90m",
  info: "\u001b[36m",
  success: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};
const RESET = "\u001b[0m";

export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  data?: unknown;
}

export class EventLogger {
  private readonly verbose: boolean;
  private readonly quiet: boolean;
  private readonly color: boolean;
  private readonly stream: NodeJS.WriteStream | null;

  constructor(
    private readonly runDir?: string,
    options: { verbose?: boolean; quiet?: boolean } = {},
  ) {
    this.verbose = Boolean(options.verbose);
    this.quiet = Boolean(options.quiet);
    this.color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    this.stream = this.quiet ? null : process.stdout;
    if (runDir) fs.mkdirSync(runDir, { recursive: true });
  }

  child(runDir: string): EventLogger {
    return new EventLogger(runDir, { verbose: this.verbose, quiet: this.quiet });
  }

  debug(event: string, message: string, data?: unknown): void {
    if (this.verbose) this.log("debug", event, message, data);
  }

  info(event: string, message: string, data?: unknown): void {
    this.log("info", event, message, data);
  }

  success(event: string, message: string, data?: unknown): void {
    this.log("success", event, message, data);
  }

  warn(event: string, message: string, data?: unknown): void {
    this.log("warn", event, message, data);
  }

  error(event: string, message: string, data?: unknown): void {
    this.log("error", event, message, data);
  }

  raw(line: string): void {
    this.stream?.write(`${line}\n`);
  }

  private log(level: LogLevel, event: string, message: string, data?: unknown): void {
    const record: LogEvent = {
      ts: nowIso(),
      level,
      event,
      message: redactSecrets(message),
      ...(data === undefined ? {} : { data: redactDeep(data) }),
    };
    if (this.runDir) {
      try {
        fs.appendFileSync(path.join(this.runDir, "events.jsonl"), `${JSON.stringify(record)}\n`);
      } catch {
        // Ghi log không được làm hỏng run.
      }
    }
    if (this.stream) {
      const time = record.ts.slice(11, 19);
      const label = level.toUpperCase().padEnd(7);
      const prefix = this.color ? `${COLORS[level]}${time} ${label}${RESET}` : `${time} ${label}`;
      this.stream.write(`${prefix} ${message}\n`);
      if (this.verbose && data !== undefined) {
        this.stream.write(`${this.color ? COLORS.debug : ""}${JSON.stringify(redactDeep(data), null, 2)}${this.color ? RESET : ""}\n`);
      }
    }
  }
}
