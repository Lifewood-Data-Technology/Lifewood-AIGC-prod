import type { IncomingMessage, ServerResponse } from "node:http";

/** Do not pipe a completed operation's response into an already closed socket. */
export async function sendOpenResponse(response: Response, req: IncomingMessage, res: ServerResponse,
  send: (response: Response, req: IncomingMessage, res: ServerResponse, compress: boolean) => Promise<void>) {
  const closed = () => res.destroyed || res.closed || res.writableEnded;
  if (closed()) { await response.body?.cancel().catch(() => {});console.info({event:"http.response.client_closed"});return; }
  try { await send(response, req, res, true); }
  catch (error) {
    // The peer can close between the check and pipeline setup. Suppress only
    // the known closed-destination classification; storage/API errors propagate.
    const code = (error as {code?: string})?.code;
    if (closed() && ["ERR_STREAM_UNABLE_TO_PIPE", "ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"].includes(code || "")) {console.info({event:"http.response.client_closed",code});return;}
    throw error;
  }
}
