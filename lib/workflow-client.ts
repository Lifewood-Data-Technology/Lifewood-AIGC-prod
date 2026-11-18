import { workspaceFetch as fetch } from "./tab-session";
/** Never retry writes automatically: a timed-out request may already have committed. */
export async function requestWorkflow<T>(action: string, payload: Record<string, string>, timeoutMs = 30_000): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error("WORKFLOW_TIMEOUT")); controller.abort(); }, timeoutMs);
      }),
      (async () => {
        const response = await fetch("/api/workflow", {
          method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }),
        });
        const body = await response.json() as T;
        return { response, body };
      })(),
    ]);
  } finally { clearTimeout(timer); }
}
