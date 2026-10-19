import * as fs from "fs";
import * as path from "path";
import { CONFIG_DIR } from "./config.js";

const HISTORY_FILE = path.join(CONFIG_DIR, "print-history.json");

/** A cloud task record as last seen, keyed by task ID in the archive. */
export interface ArchivedTask {
  firstSeenAt: string;
  lastSeenAt: string;
  /** The complete API record, including its signed asset links. */
  task: Record<string, unknown>;
}

export function getHistoryPath(): string {
  return HISTORY_FILE;
}

export function loadHistory(): Record<string, ArchivedTask> {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/** Upsert task records into the archive; returns the archive size. */
export function archiveTasks(tasks: Record<string, unknown>[]): number {
  const archive = loadHistory();
  const now = new Date().toISOString();
  for (const task of tasks) {
    const id = String(task.id);
    archive[id] = {
      firstSeenAt: archive[id]?.firstSeenAt ?? now,
      lastSeenAt: now,
      task,
    };
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(archive, null, 2), { mode: 0o600 });
  return Object.keys(archive).length;
}
