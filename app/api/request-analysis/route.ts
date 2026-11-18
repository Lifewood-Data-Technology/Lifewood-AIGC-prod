import {
  analyzeProjectRequest,
  confirmProjectRequestAnalysis,
  getProjectRequestAnalysisStatus,
  localizeProjectRequestAnalysis,
} from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { ZhipuError } from "../../../db/zhipu";
import { zhipuErrorText } from "../../../lib/zhipu-errors";

export async function GET(request: Request) {
  try {
    const requestId = new URL(request.url).searchParams.get("requestId") ?? "";
    return Response.json(
      await getProjectRequestAnalysisStatus(
        authenticatedEmail(request),
        requestId,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return apiError(error, "Unable to load analysis status.");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "analyze" | "confirm" | "localize";
      requestId?: string;
    };
    const actorEmail = authenticatedEmail(request);
    if (body.action === "localize") return Response.json(await localizeProjectRequestAnalysis(actorEmail, body.requestId ?? ""));
    if (body.action === "analyze")
      return Response.json(
        await analyzeProjectRequest(actorEmail, body.requestId ?? ""),
      );
    if (body.action === "confirm")
      return Response.json(
        await confirmProjectRequestAnalysis(actorEmail, body.requestId ?? ""),
      );
    return Response.json({ error: "Unsupported analysis action." }, { status: 400 });
  } catch (error) {
    if (error instanceof ZhipuError) {
      // The adapter redacts credentials and URLs before building this message.
      console.error("Zhipu AI requirements analysis failed", { code: error.code, upstreamStatus: error.upstreamStatus });
      return Response.json(
        { error: `[ZHIPU_${error.code}] ${zhipuErrorText(error.code)}`, code: `ZHIPU_${error.code}` },
        { status: error.code === "QUOTA" ? 429 : error.code === "TIMEOUT" ? 504 : 502 },
      );
    }
    return apiError(error, "Requirements analysis failed.");
  }
}
