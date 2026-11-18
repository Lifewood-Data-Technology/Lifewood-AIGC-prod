const messages = {
  AUTH: ["Zhipu rejected the API key. Check or replace the server-side key.", "智谱 拒绝了当前密钥，请检查或更换服务端密钥。"],
  PERMISSION: ["Zhipu denied access. Check the API key permissions and account status.", "智谱 拒绝访问，请检查密钥权限和账号状态。"],
  QUOTA: ["The free model is busy or its request limit has been reached. The system tried the fallback model; retry shortly.", "免费模型当前繁忙或请求额度已达上限，系统已尝试备用模型，请稍后重试。"],
  TIMEOUT: ["Zhipu timed out. Your source documents are retained; retry later.", "智谱 响应超时，原始文档已保留，请稍后重试。"],
  NETWORK: ["The server could not connect to Zhipu. Your source documents are retained; retry later.", "服务器暂时无法连接智谱，原始文档已保留，请稍后重试。"],
  CONFIG: ["The server could not construct the Zhipu request. Ask the administrator to check the integration settings.", "服务器无法正确构建智谱 请求，请联系管理员检查接口配置。"],
  UNAVAILABLE: ["Zhipu is temporarily unavailable. Retry later.", "智谱 服务暂时不可用，请稍后重试。"],
  MODEL: ["The configured Zhipu model is unavailable. Check the server model setting.", "当前配置的智谱 模型不可用，请检查服务端模型设置。"],
  REQUEST: ["Zhipu rejected the request. Check the diagnostic details below.", "智谱 拒绝了此次请求，请根据下方诊断信息检查文档或配置。"],
  PROTOCOL: ["Zhipu returned an unexpected response. Source documents are retained.", "智谱 返回的信息不符合预期，原始文档已保留。"],
  PROCESSING: ["Zhipu could not finish parsing the document. Retry later.", "智谱 尚未完成文档解析，请稍后重试。"],
  OUTPUT: ["Zhipu did not return a complete requirements summary. Retry; no business status has been changed.", "智谱 未返回完整的需求概要，请重新解析；业务状态未改变。"],
  BLOCKED: ["Zhipu could not produce a result because of content restrictions. Review the source document.", "智谱 因内容限制未生成结果，请检查原始文档。"],
} as const;

export type ZhipuErrorCode = keyof typeof messages;

export function zhipuErrorText(code: ZhipuErrorCode, locale: "zh" | "en" = "en") {
  return messages[code][locale === "zh" ? 1 : 0];
}

export function localizeZhipuError(message: string, locale: "zh" | "en") {
  const match = message.match(/^\[ZHIPU_([A-Z_]+)\]/);
  if (!match || !(match[1] in messages)) return null;
  const diagnostic = message.indexOf("\n");
  return zhipuErrorText(match[1] as ZhipuErrorCode, locale) +
    (diagnostic < 0 ? "" : message.slice(diagnostic));
}
