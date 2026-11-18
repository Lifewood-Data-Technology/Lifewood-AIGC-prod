export const presenceFreshMs = 90_000;
export const presenceAwayMs = 5 * 60_000;
export type PresenceState = "online" | "away" | "unknown" | "offline";
export type ClientInfo = { ip: string; browser: string; os: string };
export type AccessRow = {
  email: string; name: string; group: string; status: string;
  presence: PresenceState; sessionStartedAt: string | null; sessionExpiresAt: string | null;
  lastContactAt: string | null; lastActivityAt: string | null; lastSignIn: string | null;
  loginIp: string; currentIp: string; browser: string; os: string;
};
export type LoginEvent = "signed_in" | "resumed" | "failed" | "locked" | "blocked" | "signed_out";
export type AccessEvent = { id: string; occurred_at: string; event: LoginEvent; ip_address: string; browser: string; os: string };

export function presenceState(row: { status: string; expires_at?: unknown; last_seen_at?: unknown; last_contact_at?: unknown; last_activity_at?: unknown; visible?: unknown }, now = Date.now()): PresenceState {
  const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
  if (row.status !== "active" || !(time(row.expires_at) > now) || !(time(row.last_seen_at) > now - 30 * 60_000)) return "offline";
  const contact = time(row.last_contact_at);
  if (!Number.isFinite(contact) || contact > now + 5_000 || now - contact >= presenceFreshMs) return "unknown";
  return Number(row.visible) === 1 && time(row.last_activity_at) > now - presenceAwayMs ? "online" : "away";
}

export function safeIp(value: string | null): string {
  if (!value || value.length > 45) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split(".").every(part => Number(part) <= 255) ? value : "";
  if (/^[a-f\d:.]+$/i.test(value) && value.includes(":")) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { /* Invalid IPv6. */ }
  }
  return "";
}

/** Only fixed product labels and major versions, never the raw user-agent. */
export function clientSoftware(agent: string): Pick<ClientInfo, "browser" | "os"> {
  const ua = agent.slice(0, 512);
  const candidates: Array<[string, RegExp]> = [["Edge", /(?:Edg|EdgiOS|EdgA)\/(\d+)/], ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/], ["Chrome", /(?:Chrome|CriOS)\/(\d+)/], ["Safari", /Version\/(\d+).*Safari\//]];
  let browser = "";
  for (const [name, pattern] of candidates) { const match = ua.match(pattern); if (match) { browser = `${name} ${match[1].slice(0, 4)}`; break; } }
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS / iPadOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return { browser, os };
}

export const presenceLabels = {
  online: ["在线", "Online"], away: ["暂离", "Away"], unknown: ["连接待确认", "Connection unconfirmed"], offline: ["离线", "Offline"],
} as const;
export const loginEventLabels = {
  signed_in: ["登录成功", "Signed in"], resumed: ["原浏览器恢复登录", "Session recovered"],
  failed: ["登录失败：凭据不正确或账号停用", "Failed: invalid credentials or disabled account"],
  locked: ["登录失败：尝试过多，暂时锁定", "Failed: temporarily locked"],
  blocked: ["登录被拒：已有有效登录", "Blocked: an existing session is active"], signed_out: ["主动退出", "Signed out"],
} as const;
