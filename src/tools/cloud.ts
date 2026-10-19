import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FleetManager } from "../fleet-manager.js";
import type { PrinterConfig } from "../types.js";
import { addPrinterToConfig, loadConfig } from "../config.js";
import {
  loadCloud,
  saveCloud,
  clearCloud,
  getCloudPath,
  type CloudCredentials,
} from "../cloud-store.js";
import {
  listDevices,
  listPrintTasks,
  refreshToken,
  deriveTokenInfo,
  type CloudDevice,
  type PrintTask,
} from "../bambu-cloud.js";
import { archiveTasks, getHistoryPath } from "../history-store.js";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 1000;

const STATUS_LABELS: Record<PrintTask["status"], string> = {
  success: "Success",
  failed: "Canceled/Failed",
  printing: "Printing",
  unknown: "Unknown",
};

/** "2026-10-18T22:40:49Z" → "2026-10-18 22:40 UTC". */
function formatUtc(iso?: string): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—";
}

/** Bambu Studio style: hours to one decimal, else whole minutes, else seconds. */
function formatDuration(seconds?: number): string {
  if (seconds === undefined) return "—";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}min`;
  return `${Math.round(seconds)}s`;
}

/** Markdown link to the MakerWorld model, or a dash when the job has none. */
function formatMakerWorld(designId: number): string {
  return designId
    ? `[${designId}](https://makerworld.com/en/models/${designId})`
    : "—";
}

/** Map a configured printer ID to its serial; throws with the valid IDs. */
function serialForPrinterId(printerId: string): string {
  const printers = loadConfig().printers;
  const match = printers.find((p) => p.id === printerId);
  if (!match) {
    throw new Error(
      `Printer '${printerId}' not found. Available: ${printers.map((p) => p.id).join(", ") || "none"}`,
    );
  }
  return match.serialNumber;
}

function formatHistory(
  tasks: PrintTask[],
  total: number,
  scope: string,
  archived: number,
): string {
  if (tasks.length === 0) return "No print jobs match.";

  const byPrinter = new Map<string, Record<PrintTask["status"], number> & { grams: number }>();
  for (const t of tasks) {
    const row =
      byPrinter.get(t.printerName) ??
      { success: 0, failed: 0, printing: 0, unknown: 0, grams: 0 };
    row[t.status] += 1;
    if (t.status === "success") row.grams += t.weightGrams;
    byPrinter.set(t.printerName, row);
  }

  const lines = [
    "# Print History",
    `Showing ${tasks.length} job(s), newest first. Total jobs for ${scope}: ${total}.`,
    "",
    "| Printer | Jobs | Success | Canceled/Failed | Printing | Filament (successful) |",
    "|---|---|---|---|---|---|",
  ];
  for (const [name, r] of [...byPrinter].sort(([a], [b]) => a.localeCompare(b))) {
    const jobs = r.success + r.failed + r.printing + r.unknown;
    lines.push(
      `| ${name} | ${jobs} | ${r.success} | ${r.failed} | ${r.printing} | ${Math.round(r.grams)} g |`,
    );
  }

  lines.push(
    "",
    "| Started | Printer | Model | MakerWorld | Plate | Actual time | Est. time | Est. weight | Result |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const t of tasks) {
    lines.push(
      `| ${formatUtc(t.startTime)} | ${t.printerName} | ${t.title.replace(/\|/g, "\\|")} | ${formatMakerWorld(t.designId)} | ${t.plate} | ${formatDuration(t.actualSeconds)} | ${formatDuration(t.estimatedSeconds)} | ${t.weightGrams.toFixed(1)} g | ${STATUS_LABELS[t.status]} |`,
    );
  }

  lines.push(
    "",
    "Actual time is end minus start for finished jobs (canceled jobs show time until cancel). Est. time and weight are slicer estimates. The cloud reports canceled and failed jobs with the same code. Use get_status for a printer's live state.",
    "",
    `Complete records (all API fields, including signed cover/plate-metadata links that expire 30–60 min after this fetch) archived to ${getHistoryPath()} (${archived} jobs). Use format "json" for the full records.`,
  );
  return lines.join("\n");
}

/** Get a currently-valid access token, refreshing if expired. Returns null if not logged in. */
async function validToken(): Promise<CloudCredentials | null> {
  let creds = loadCloud();
  if (!creds) return null;
  const now = Math.floor(Date.now() / 1000);
  if (creds.expiresAt && creds.expiresAt - now < 3600 && creds.refreshToken) {
    try {
      const r = await refreshToken(creds.refreshToken, creds.region);
      if (r.status === "success" && r.accessToken) {
        const info = deriveTokenInfo(r.accessToken);
        creds = {
          ...creds,
          accessToken: r.accessToken,
          refreshToken: r.refreshToken || creds.refreshToken,
          username: r.username || info.username || creds.username,
          expiresAt: r.expiresAt || info.expiresAt,
          savedAt: new Date().toISOString(),
        };
        saveCloud(creds);
      }
    } catch {
      /* fall through with existing token */
    }
  }
  return creds;
}

export interface SyncResult {
  loggedIn: boolean;
  devices: CloudDevice[];
  connected: string[];
  failed: { id: string; error: string }[];
  error?: string;
}

/** Discover cloud printers, persist them (mode:"cloud"), and connect them. */
export async function syncCloudPrinters(
  fleet: FleetManager,
): Promise<SyncResult> {
  const creds = await validToken();
  if (!creds) {
    return {
      loggedIn: false,
      devices: [],
      connected: [],
      failed: [],
      error: "Not logged in to Bambu cloud. Run `npm run login`.",
    };
  }

  let devices: CloudDevice[];
  try {
    devices = await listDevices(creds.accessToken, creds.region);
  } catch (e: any) {
    return {
      loggedIn: true,
      devices: [],
      connected: [],
      failed: [],
      error: `Could not list cloud printers: ${e.message}`,
    };
  }

  const connected: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const d of devices) {
    const id = `cloud-${d.dev_id}`;
    const config: PrinterConfig = {
      id,
      name: `${d.name} (cloud)`,
      host: "us.mqtt.bambulab.com", // display only; real host resolved by region
      accessCode: "",
      serialNumber: d.dev_id,
      model: d.model,
      mode: "cloud",
      region: creds.region,
    };
    addPrinterToConfig(config);
    try {
      await fleet.connectPrinter(config);
      connected.push(id);
    } catch (e: any) {
      failed.push({ id, error: e.message });
    }
  }

  return { loggedIn: true, devices, connected, failed };
}

export function registerCloudTools(
  server: McpServer,
  fleet: FleetManager,
): void {
  server.tool(
    "cloud_status",
    "Show Bambu cloud login status: whether credentials exist, the account, region, token expiry, and how many cloud printers are connected.",
    {},
    async () => {
      const creds = loadCloud();
      if (!creds) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Not logged in to Bambu cloud.\nRun \`npm run login\` in the bambu-mcp directory to enable cloud control.\nCredential file (when logged in): ${getCloudPath()}`,
            },
          ],
        };
      }
      const now = Math.floor(Date.now() / 1000);
      const exp = creds.expiresAt
        ? `${new Date(creds.expiresAt * 1000).toLocaleString()}${creds.expiresAt < now ? " (EXPIRED — run `npm run login`)" : ""}`
        : "unknown";
      const cloudPrinters = loadConfig().printers.filter(
        (p) => p.mode === "cloud",
      );
      const lines = [
        "# Bambu Cloud Status",
        `- **Account:** ${creds.email}`,
        `- **Region:** ${creds.region}`,
        `- **MQTT user:** ${creds.username}`,
        `- **Token expires:** ${exp}`,
        `- **Cloud printers configured:** ${cloudPrinters.length}`,
        "",
      ];
      for (const p of cloudPrinters) {
        const conn = fleet.getPrinter(p.id);
        lines.push(
          `  • ${p.name} (\`${p.id}\`) — ${conn?.mqtt.isConnected() ? "connected" : "disconnected"}`,
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "sync_cloud_printers",
    "Discover printers bound to your Bambu cloud account and connect them over the cloud MQTT broker (works remotely, off your LAN). Requires `npm run login` first.",
    {},
    async () => {
      const res = await syncCloudPrinters(fleet);
      if (res.error) {
        return { content: [{ type: "text" as const, text: res.error }] };
      }
      if (res.devices.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Logged in, but no printers are bound to this account.",
            },
          ],
        };
      }
      const lines = [`Found ${res.devices.length} cloud printer(s):`, ""];
      for (const d of res.devices) {
        const id = `cloud-${d.dev_id}`;
        const ok = res.connected.includes(id);
        const fail = res.failed.find((f) => f.id === id);
        lines.push(
          `• ${d.name} [${d.model || "?"}] (\`${id}\`) — ${
            ok ? "connected" : fail ? `failed: ${fail.error}` : "not connected"
          }${d.online ? "" : " · printer offline"}`,
        );
      }
      lines.push("", "Use get_status, pause_print, etc. with these IDs (or 'all').");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_print_history",
    "Get print-job history from the Bambu cloud account (the same list as Bambu Studio's Print History page), newest first. Returns a per-printer summary and one row per job: start time, printer, model, plate, actual time (finished jobs), estimated time and filament, and result. Covers every printer bound to the account, including jobs started from Bambu Studio, Handy, or the printer screen. Each job carries its MakerWorld model ID when it was started from MakerWorld (look it up with a MakerWorld tool for designer, license and remix origin). Every fetch also saves the complete API records, including signed cover-image and plate-metadata links, to a local archive. Use format 'json' to get every field. Requires cloud login. For a printer's current live state use get_status instead.",
    {
      printer: z
        .string()
        .optional()
        .describe(
          "Printer ID to restrict the history to (e.g. 'cloud-01P00C540300990', from list_printers). Omit for all printers on the account.",
        ),
      status: z
        .enum(["success", "failed", "printing"])
        .optional()
        .describe(
          "Only return jobs with this result. 'failed' includes canceled jobs; the cloud does not distinguish them.",
        ),
      since: z
        .string()
        .refine((s) => !Number.isNaN(Date.parse(s)), "Must be an ISO date or date-time.")
        .optional()
        .describe(
          "Only return jobs started at or after this ISO date/date-time (e.g. '2026-10-01'). Date-only values are UTC midnight.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(HISTORY_MAX_LIMIT)
        .default(HISTORY_DEFAULT_LIMIT)
        .describe(
          `Maximum number of jobs to return (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}).`,
        ),
      format: z
        .enum(["table", "json"])
        .default("table")
        .describe(
          "table (default): summary and one row per job. json: the complete API record for each job, including AMS filament mapping, nozzle, MakerWorld profile and signed asset links (large: ~5 KB per job).",
        ),
    },
    async ({ printer, status, since, limit, format }) => {
      const text = (t: string, isError = false) => ({
        content: [{ type: "text" as const, text: t }],
        isError,
      });
      const creds = await validToken();
      if (!creds) {
        return text("Not logged in to Bambu cloud. Run `npm run login`.", true);
      }
      try {
        const { tasks, total, scanned } = await listPrintTasks(
          creds.accessToken,
          creds.region,
          {
            serial: printer ? serialForPrinterId(printer) : undefined,
            status,
            since: since ? new Date(since) : undefined,
            max: limit,
          },
        );
        const archived = archiveTasks(scanned);
        if (format === "json") {
          return text(
            JSON.stringify({ total, archive: getHistoryPath(), tasks: tasks.map((t) => t.raw) }, null, 2),
          );
        }
        return text(
          formatHistory(tasks, total, printer ?? "the account", archived),
        );
      } catch (e: any) {
        return text(`Could not fetch print history: ${e.message}`, true);
      }
    },
  );

  server.tool(
    "cloud_logout",
    "Log out of Bambu cloud: delete stored cloud credentials and disconnect cloud printers. LAN printers are unaffected.",
    {},
    async () => {
      const cloudPrinters = loadConfig().printers.filter(
        (p) => p.mode === "cloud",
      );
      for (const p of cloudPrinters) fleet.disconnectPrinter(p.id);
      const cleared = clearCloud();
      return {
        content: [
          {
            type: "text" as const,
            text: cleared
              ? `Logged out. Cleared credentials and disconnected ${cloudPrinters.length} cloud printer(s). (Cloud printer entries remain in config but won't connect until you log in again.)`
              : "No cloud credentials were stored.",
          },
        ],
      };
    },
  );
}
