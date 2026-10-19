/**
 * Bambu Lab cloud API client.
 *
 * Implements the account login + device-discovery flow used by Bambu Handy /
 * Bambu Studio / OrcaSlicer, so printers can be controlled over the internet
 * via Bambu's cloud MQTT broker instead of the local network.
 *
 * Login can complete in one step, or return a challenge:
 *   - "verifyCode": Bambu emails a code; call login again with that code.
 *   - "tfa":        account has TOTP 2FA; complete via the tfa endpoint.
 *
 * References: the pybambu (Home Assistant ha-bambulab) cloud implementation.
 */

const API_HOST_GLOBAL = "https://api.bambulab.com";
const API_HOST_CHINA = "https://api.bambulab.cn";

function apiHost(region?: string): string {
  return (region || "").toLowerCase().startsWith("china")
    ? API_HOST_CHINA
    : API_HOST_GLOBAL;
}

// Headers mimicking the Bambu network agent — required or Cloudflare 403s.
function baseHeaders(): Record<string, string> {
  return {
    "User-Agent": "bambu_network_agent/01.09.05.01",
    "X-BBL-Client-Name": "OrcaSlicer",
    "X-BBL-Client-Type": "slicer",
    "X-BBL-Client-Version": "01.09.05.01",
    "X-BBL-Language": "en-US",
    "X-BBL-OS-Type": "linux",
    "X-BBL-OS-Version": "6.2.0",
    "X-BBL-Agent-Version": "01.09.05.01",
    "X-BBL-Executable-info": "{}",
    "X-BBL-Agent-OS-Type": "linux",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export interface LoginResult {
  status: "success" | "verifyCode" | "tfa" | "error";
  accessToken?: string;
  refreshToken?: string;
  /** MQTT username derived from the token (e.g. "u_1234567"). */
  username?: string;
  /** Unix seconds expiry from the JWT, if decodable. */
  expiresAt?: number;
  /** Present when status === "tfa". */
  tfaKey?: string;
  message?: string;
}

export interface CloudDevice {
  dev_id: string;
  name: string;
  online: boolean;
  model?: string;
  productName?: string;
}

/** Decode a JWT payload without verifying (we only need claims). */
function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** MQTT username + expiry from an access token. */
export function deriveTokenInfo(token: string): {
  username?: string;
  expiresAt?: number;
} {
  const claims = decodeJwt(token);
  if (!claims) return {};
  // The token carries a "username" claim already in "u_<uid>" form.
  let username: string | undefined =
    typeof claims.username === "string" ? claims.username : undefined;
  if (!username && claims.uid != null) username = `u_${claims.uid}`;
  const expiresAt =
    typeof claims.exp === "number" ? claims.exp : undefined;
  return { username, expiresAt };
}

function buildLoginResult(data: any): LoginResult {
  const accessToken: string = data?.accessToken || "";
  if (accessToken) {
    const info = deriveTokenInfo(accessToken);
    return {
      status: "success",
      accessToken,
      refreshToken: data?.refreshToken || undefined,
      username: info.username,
      expiresAt: info.expiresAt,
    };
  }
  const loginType: string = data?.loginType || "";
  if (loginType === "verifyCode") {
    return { status: "verifyCode", message: "Email verification code required." };
  }
  if (loginType === "tfa") {
    return {
      status: "tfa",
      tfaKey: data?.tfaKey,
      message: "Two-factor (TOTP) code required.",
    };
  }
  return {
    status: "error",
    message:
      data?.message ||
      `Login did not return a token (loginType="${loginType || "unknown"}").`,
  };
}

async function postJson(
  url: string,
  body: Record<string, any>,
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text };
}

/** Step 1: password login. May succeed or return a challenge. */
export async function login(
  email: string,
  password: string,
  region?: string,
): Promise<LoginResult> {
  const { ok, status, data, text } = await postJson(
    `${apiHost(region)}/v1/user-service/user/login`,
    { account: email, password, apiError: "" },
  );
  if (!ok && !data) {
    throw new Error(
      `Login HTTP ${status}. ${status === 403 ? "Cloudflare blocked the request — try again shortly, or use a token from Bambu Handy." : text.slice(0, 200)}`,
    );
  }
  return buildLoginResult(data);
}

/** Ask Bambu to email a login verification code. */
export async function requestEmailCode(
  email: string,
  region?: string,
): Promise<void> {
  const { ok, status, text } = await postJson(
    `${apiHost(region)}/v1/user-service/user/sendemail/code`,
    { email, type: "codeLogin" },
  );
  if (!ok) {
    throw new Error(`Failed to request email code: HTTP ${status} ${text.slice(0, 160)}`);
  }
}

/** Step 2 (email path): complete login with the emailed code. */
export async function loginWithCode(
  email: string,
  code: string,
  region?: string,
): Promise<LoginResult> {
  const { data } = await postJson(
    `${apiHost(region)}/v1/user-service/user/login`,
    { account: email, code },
  );
  return buildLoginResult(data);
}

/** Step 2 (TOTP path): complete login with a 2FA authenticator code. */
export async function loginWithTfa(
  tfaKey: string,
  tfaCode: string,
): Promise<LoginResult> {
  // The TFA endpoint lives on the www host and returns the token in a cookie.
  const res = await fetch("https://bambulab.com/api/sign-in/tfa", {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ tfaKey, tfaCode }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = /token=([^;]+)/.exec(setCookie);
  if (!match) {
    const text = await res.text();
    return {
      status: "error",
      message: `TFA did not return a token (HTTP ${res.status}). ${text.slice(0, 160)}`,
    };
  }
  const accessToken = decodeURIComponent(match[1]);
  const info = deriveTokenInfo(accessToken);
  return {
    status: "success",
    accessToken,
    username: info.username,
    expiresAt: info.expiresAt,
  };
}

/** Refresh an access token using the refresh token. */
export async function refreshToken(
  refresh: string,
  region?: string,
): Promise<LoginResult> {
  const { data } = await postJson(
    `${apiHost(region)}/v1/user-service/user/refreshtoken`,
    { refreshToken: refresh },
  );
  return buildLoginResult(data);
}

/** Authenticated GET returning parsed JSON; `label` prefixes error messages. */
async function getJson(
  label: string,
  url: string,
  accessToken: string,
): Promise<any> {
  const res = await fetch(url, {
    method: "GET",
    headers: { ...baseHeaders(), Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response.`);
  }
}

/**
 * Get the MQTT username ("u_<uid>") for an account by querying the profile API.
 * Authoritative fallback when the JWT doesn't carry a usable username claim.
 */
export async function getAccountUsername(
  accessToken: string,
  region?: string,
): Promise<string> {
  const data = await getJson(
    "profile lookup",
    `${apiHost(region)}/v1/design-user-service/my/preference`,
    accessToken,
  );
  const uid = data?.uid ?? data?.userId ?? data?.user_id ?? data?.uidStr;
  if (uid == null || uid === "") {
    throw new Error(
      `profile response had no uid (keys: ${Object.keys(data || {}).slice(0, 12).join(", ")})`,
    );
  }
  return `u_${uid}`;
}

/** List printers bound to the account. */
export async function listDevices(
  accessToken: string,
  region?: string,
): Promise<CloudDevice[]> {
  const data = await getJson(
    "listDevices",
    `${apiHost(region)}/v1/iot-service/api/user/bind`,
    accessToken,
  );
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  return devices.map((d: any) => ({
    dev_id: d.dev_id,
    name: d.name || d.dev_id,
    online: !!d.online,
    model: d.dev_model_name || d.dev_product_name,
    productName: d.dev_product_name,
  }));
}

export type PrintTaskStatus = "success" | "failed" | "printing" | "unknown";

/** Cloud task status codes. The API uses 3 for both canceled and failed jobs. */
const TASK_STATUS: Record<number, PrintTaskStatus> = {
  2: "success",
  3: "failed",
  4: "printing",
};

export interface PrintTask {
  id: number;
  serial: string;
  printerName: string;
  /** Model title from MakerWorld when available, else the job/file title. */
  title: string;
  plate: number;
  /** ISO-8601 UTC. */
  startTime: string;
  /** ISO-8601 UTC. Unreliable while status is "printing". */
  endTime?: string;
  /** Slicer-estimated print time in seconds, not the actual duration. */
  estimatedSeconds: number;
  /** Slicer-estimated filament weight in grams. */
  weightGrams: number;
  status: PrintTaskStatus;
  statusCode: number;
}

export interface ListPrintTasksOptions {
  /** Restrict to one printer (serial number); filtered server-side. */
  serial?: string;
  /** Keep only tasks with this status; filtered client-side. */
  status?: PrintTaskStatus;
  /** Stop once this many matching tasks are collected. */
  max: number;
  /** Stop at tasks that started before this instant. */
  since?: Date;
}

/** The API silently clamps page sizes above this to 20. */
const TASK_PAGE_SIZE = 100;

function toPrintTask(t: any): PrintTask {
  const code = Number(t.status);
  return {
    id: t.id,
    serial: t.deviceId,
    printerName: t.deviceName || t.deviceId,
    title: (t.designTitle || t.title || "").trim(),
    plate: t.plateIndex,
    startTime: t.startTime,
    endTime: t.endTime || undefined,
    estimatedSeconds: t.costTime ?? 0,
    weightGrams: t.weight ?? 0,
    status: TASK_STATUS[code] ?? "unknown",
    statusCode: code,
  };
}

/**
 * Print-job history for the account, newest first.
 *
 * Uses `/v1/user-service/my/tasks`, the endpoint behind the Print History page
 * in Bambu Studio / Handy. It is undocumented; field names follow the
 * community reverse-engineering (OpenBambuAPI, ha-bambulab).
 */
export async function listPrintTasks(
  accessToken: string,
  region: string | undefined,
  opts: ListPrintTasksOptions,
): Promise<{ tasks: PrintTask[]; total: number }> {
  const tasks: PrintTask[] = [];
  let total = 0;
  for (let offset = 0; ; offset += TASK_PAGE_SIZE) {
    const query = new URLSearchParams({
      limit: String(TASK_PAGE_SIZE),
      offset: String(offset),
    });
    if (opts.serial) query.set("deviceId", opts.serial);
    const data = await getJson(
      "listPrintTasks",
      `${apiHost(region)}/v1/user-service/my/tasks?${query}`,
      accessToken,
    );
    total = Number(data?.total) || 0;
    const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];
    for (const hit of hits) {
      const task = toPrintTask(hit);
      if (opts.since && new Date(task.startTime) < opts.since) {
        return { tasks, total };
      }
      if (opts.status && task.status !== opts.status) continue;
      tasks.push(task);
      if (tasks.length >= opts.max) return { tasks, total };
    }
    if (hits.length < TASK_PAGE_SIZE || offset + hits.length >= total) {
      return { tasks, total };
    }
  }
}
