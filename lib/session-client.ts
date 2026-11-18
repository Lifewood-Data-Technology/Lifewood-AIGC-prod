import { workspaceFetch as fetch } from "./tab-session";
/** Bound the entire request, including JSON body reads. Never retry a login automatically. */
export type SessionExitReason = "expired" | "replaced" | "policy-changed";

/** Translate retained UI feedback without retrying authentication or losing its warning. */
export function localizeLoginFeedback(message: string, locale: "zh" | "en") {
  const occupied = "本浏览器的原工作台仍在使用。请先在原标签页退出，再登录；不会挤掉原来的登录。";
  const unavailable = "浏览器无法启用标签页保护，请通过 HTTPS 使用支持 Web Locks 的浏览器。";
  const english = "The original workspace is still open, or tab protection is unavailable. Sign out there first; its login will not be replaced.";
  if (locale === "en" && [occupied, unavailable].includes(message)) return english;
  if (locale === "zh" && message === english) return "原工作台仍在使用，或浏览器暂不支持标签页保护。请先在原标签页退出；本次不会挤掉原来的登录。";
  return message;
}

export function sessionExitReason(code: string | null | undefined): SessionExitReason {
  return code === "SESSION_REPLACED" ? "replaced" : code === "SESSION_POLICY_CHANGED" ? "policy-changed" : "expired";
}

export function sessionExitNotice(locale: "zh" | "en", reason: SessionExitReason | "logout") {
  const notices = {
    replaced: ["账号已在其他地方登录，本次登录已失效。若非本人操作，请联系管理员重置密码。", "Your account was signed in elsewhere. This session ended. If this was not you, contact your administrator to reset your password."],
    "policy-changed": ["登录安全规则已更新，请重新登录。账号和密码未改变。", "Sign-in security was updated. Please sign in again; your account and password are unchanged."],
    expired: ["登录状态已失效，请重新登录。", "Your session has expired. Please sign in again."],
    logout: ["此账号已在另一个标签页退出，请重新登录。", "This account was signed out in another tab. Please sign in again."],
  };
  return notices[reason][locale === "zh" ? 0 : 1];
}

export class SessionRequestTimeout extends Error {
  constructor() {
    super("SESSION_REQUEST_TIMEOUT");
    this.name = "SessionRequestTimeout";
  }
}

/** Keep legacy private-cache cleanup without putting browser cache deletion on
 * the sign-in/sign-out critical path. No account data or tab proof is sent.
 */
export function purgePrivateCache() {
  if (typeof window === "undefined") return;
  try {
    void globalThis.fetch("/api/session-cache", { method: "POST", credentials: "omit", cache: "no-store",
      keepalive: true, signal: AbortSignal.timeout(15_000) }).catch(() => {});
  } catch { /* Optional browser cleanup must never undo a confirmed session transition. */ }
}

export async function requestSession<T>(init: RequestInit = {}, timeoutMs = 15_000): Promise<{ response: Response; body: T | null }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new DOMException("Session check canceled", "AbortError"));
    };
    if (init.signal?.aborted) {
      onAbort();
      return;
    }
    init.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new SessionRequestTimeout());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      interrupted,
      (async () => {
        if (controller.signal.aborted) throw new DOMException("Session check canceled", "AbortError");
        const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", ...init, signal: controller.signal });
        const body = response.status === 204 ? null : await response.json() as T;
        return { response, body };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) init.signal?.removeEventListener("abort", onAbort);
  }
}

/** Locale is only a preference; blocked browser storage must never prevent sign-in. */
export function storedLocale(getStorage: () => Pick<Storage, "getItem">): "zh" | "en" {
  try {
    return getStorage().getItem("lifewood-locale") === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}
