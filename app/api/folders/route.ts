import { createFolder, deleteFolder, moveManagedFile, restoreFolder, updateFolder } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { parentFolderId?: string; name?: string };
    return Response.json(await createFolder(authenticatedEmail(request), body.parentFolderId ?? "", body.name ?? ""));
  } catch (error) {
    return apiError(error, "Folder could not be created.");
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { action?: "rename" | "move" | "file.move" | "restore"; folderId?: string; fileId?: string; value?: string; targetFolderId?: string };
    const actorEmail = authenticatedEmail(request);
    if (body.action === "file.move") return Response.json(await moveManagedFile(actorEmail, body.fileId ?? "", body.targetFolderId ?? ""));
    if (body.action === "restore") return Response.json(await restoreFolder(actorEmail, body.folderId ?? ""));
    if (body.action !== "rename" && body.action !== "move") return Response.json({ error: "Unsupported folder action." }, { status: 400 });
    return Response.json(await updateFolder(actorEmail, body.folderId ?? "", body.action, body.value ?? body.targetFolderId ?? ""));
  } catch (error) {
    return apiError(error, "Folder could not be updated.");
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { folderId?: string };
    return Response.json(await deleteFolder(authenticatedEmail(request), body.folderId ?? ""));
  } catch (error) {
    return apiError(error, "Folder could not be deleted.");
  }
}
