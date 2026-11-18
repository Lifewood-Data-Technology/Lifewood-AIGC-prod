const messages = {
  AUTH: ["Gemini rejected the API key. Check or replace the server-side key.", "Gemini 拒绝了当前密钥，请检查或更换服务端密钥。"],
  KEY_BLOCKED: ["Google has blocked this API key. Replace it in the server secret settings; do not share it in chat.", "Google 已停用或拦截当前密钥。请更换服务端密钥，不要把新密钥发到聊天中。"],
  PERMISSION: ["Gemini denied access. Check that the Generative Language API is enabled and the key has permission to use it.", "Gemini 拒绝访问，请检查是否启用 Generative Language API，以及密钥的接口权限和来源限制。"],
  QUOTA: ["Gemini quota or request rate limit reached. Check the Google project quota and retry when available.", "Gemini 的额度或请求频率已达上限，请检查 Google 项目额度，恢复后再重试。"],
  TIMEOUT: ["Gemini timed out. Your source documents are retained; retry later.", "Gemini 响应超时，原始文档已保留，请稍后重试。"],
  NETWORK: ["The server could not connect to Gemini. Your source documents are retained; retry later.", "服务器暂时无法连接 Gemini，原始文档已保留，请稍后重试。"],
  CONFIG: ["The server could not construct the Gemini request. Ask the administrator to check the integration settings; re-uploading is not needed.", "服务器无法正确构建 Gemini 请求，请联系管理员检查接口配置，无需重新上传文档。"],
  UNAVAILABLE: ["Gemini is temporarily unavailable. Retry later.", "Gemini 服务暂时不可用，请稍后重试。"],
  MODEL: ["The configured Gemini model is unavailable. Check the server model setting and project access.", "当前配置的 Gemini 模型不可用，请检查模型名称和项目访问权限。"],
  REQUEST: ["Gemini rejected the request. Check the diagnostic details below.", "Gemini 拒绝了此次请求，请根据下方诊断信息检查配置或文档格式。"],
  PROTOCOL: ["Gemini returned an unexpected response. Check the diagnostic details; source documents are retained.", "Gemini 返回的信息不符合预期，请查看下方诊断信息；原始文档已保留。"],
  PROCESSING: ["Gemini could not finish processing the document. Retry later.", "Gemini 尚未完成文档处理，请稍后重试。"],
  OUTPUT: ["Gemini did not return a complete requirements summary. Retry; no business status has been changed.", "Gemini 未返回完整的需求概要，请重新解析；业务状态未改变。"],
  BLOCKED: ["Gemini could not produce a result because of its content restrictions. Review the source document.", "Gemini 因内容限制未生成结果，请检查原始文档。"],
} as const;

export type GeminiErrorCode = keyof typeof messages;

export function geminiErrorText(code: GeminiErrorCode, locale: "zh" | "en" = "en") {
  return messages[code][locale === "zh" ? 1 : 0];
}

export function localizeGeminiError(message: string, locale: "zh" | "en") {
  const match = message.match(/^\[GEMINI_([A-Z_]+)\]/);
  if (!match || !(match[1] in messages)) return null;
  const diagnostic = message.indexOf("\n");
  return geminiErrorText(match[1] as GeminiErrorCode, locale) +
    (diagnostic < 0 ? "" : message.slice(diagnostic));
}
