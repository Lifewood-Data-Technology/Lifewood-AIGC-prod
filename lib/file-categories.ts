type Row = Record<string, unknown>;
const str = (value: unknown) => String(value ?? "");
export const fileCategories = [
  { id: "inputs", folderCode: "VIEW_INPUTS", zh: "客户素材", en: "Client assets", zhMeta: "客户提供的图片、视频、产品说明和参考素材", enMeta: "Client images, videos, product information and references" },
  { id: "production", folderCode: "VIEW_PRODUCTION", zh: "制作文件", en: "Production files", zhMeta: "工程、预览和渲染输出", enMeta: "Projects, previews and renders" },
  { id: "quality", folderCode: "VIEW_QUALITY", zh: "质检文件", en: "Review records", zhMeta: "本任务的质检报告和审核记录", enMeta: "Review reports and records for this task" },
  { id: "delivery", folderCode: "VIEW_DELIVERY", zh: "交付成果", en: "Deliverables", zhMeta: "已交付的固定版本，不重复存储文件", enMeta: "Pinned delivered versions; no duplicate storage" },
] as const;
export function categoryId(languageId: unknown, category: string) { return `category:${str(languageId)}:${category}`; }
export function categoryForFolder(folder: Row, folders: Row[]) {
  const map = new Map(folders.map(row => [str(row.id), row]));
  let cursor: Row | undefined = folder;
  const seen = new Set<string>();
  while (cursor && !seen.has(str(cursor.id))) {
    seen.add(str(cursor.id));
    const code = str(cursor.folder_code).split(".")[0];
    if (["01", "02"].includes(code)) return "inputs";
    if (code === "03") return "production";
    if (code === "04") return "quality";
    if (code === "05") return "delivery";
    cursor = map.get(str(cursor.parent_folder_id));
  }
  return "";
}

/** Permission-scoped presentation only. Never moves a folder/object or grants access. */
export function fileCategoryView(folders: Row[], files: Row[], delivered: Row[], locale: "zh" | "en", access = "project") {
  const languages = new Map(folders.filter(row => row.node_type === "language").map(row => [str(row.language_project_id), row]));
  const mapping = new Map<string, string>();
  const folderById = new Map(folders.map(row => [str(row.id), row]));
  const hiddenContainers = new Set(folders.filter(row => ["videos", "video_shared"].includes(str(row.node_type))).map(row => str(row.id)));
  const visibleParent = (id: unknown) => {
    const seen = new Set<string>();
    let parent = str(id);
    while (hiddenContainers.has(parent) && !seen.has(parent)) { seen.add(parent); parent = str(folderById.get(parent)?.parent_folder_id); }
    return parent;
  };
  const viewFolders: Row[] = [];
  for (const folder of folders) {
    const language = languages.get(str(folder.language_project_id));
    const category = categoryForFolder(folder, folders);
    if (language && category) { mapping.set(str(folder.id), categoryId(folder.language_project_id, category)); continue; }
    // Presentation only: remove video shared scaffolding without deleting its contents.
    if (hiddenContainers.has(str(folder.id))) continue;
    viewFolders.push({ ...folder, parent_folder_id: visibleParent(folder.parent_folder_id) });
  }
  for (const [languageId, language] of languages) for (const category of fileCategories) {
    if (access === "quality" && category.id === "delivery") continue;
    // Category visibility follows the server's scoped folders/files; never broaden it.
    const visible = (access === "quality" && ["production", "quality"].includes(category.id)) || [...mapping.values()].includes(categoryId(languageId, category.id)) ||
      (category.id === "delivery" && delivered.some(row => str(row.language_project_id) === languageId)) ||
      files.some(row => str(row.language_project_id) === languageId && categoryForFolder(folderById.get(str(row.folder_id)) || { folder_code: row.folder_code }, folders) === category.id);
    if (!visible) continue;
    viewFolders.push({ ...language, id: categoryId(languageId, category.id), parent_folder_id: language.id, node_type: "category", folder_code: category.folderCode, is_system: 1,
      name: access === "quality" && category.id === "production" ? (locale === "zh" ? "审核成片" : "Submitted videos") : category[locale],
      name_zh: access === "quality" && category.id === "production" ? "审核成片" : category.zh,
      name_en: access === "quality" && category.id === "production" ? "Submitted videos" : category.en, path_cache: `${str(language.path_cache)}/${category[locale]}` });
  }
  const mapFile = (file: Row): Row => {
    const folder = folderById.get(str(file.folder_id));
    const category = categoryForFolder(folder || { folder_code: file.folder_code }, folders);
    const destination = mapping.get(str(file.folder_id)) || (languages.has(str(file.language_project_id)) && category ? categoryId(file.language_project_id, category) : "");
    return destination ? { ...file, physical_folder_id: file.folder_id, folder_id: destination, folder_name: folder?.name || file.folder_name } : { ...file, folder_id: visibleParent(file.folder_id) };
  };
  const viewFiles = files.map(mapFile);
  const pinned = new Set<string>();
  for (const file of delivered) {
    if (access === "quality") continue;
    if (!languages.has(str(file.language_project_id))) continue;
    const id = str(file.current_version_id);
    if (!id || pinned.has(id)) continue;
    pinned.add(id);
    const destination = categoryId(file.language_project_id, "delivery");
    const existing = viewFiles.find(row => row.current_version_id === id && row.folder_id === destination);
    if (!existing) viewFiles.push({ ...file, id: `delivered:${id}`, folder_id: destination, folder_name: locale === "zh" ? "已交付版本" : "Delivered version", delivery_view: true });
    else existing.delivery_view = true;
    // Compatibility for older releases that moved the logical record to 05.
    const production = categoryId(file.language_project_id, "production");
    if (viewFolders.some(folder => folder.id === production) && !viewFiles.some(row => row.current_version_id === id && row.folder_id === production))
      viewFiles.push({ ...file, id: `production-delivered:${id}`, folder_id: production, folder_name: locale === "zh" ? "渲染输出 · 已交付版本" : "Render · Delivered version", delivery_view: true });
  }
  return { folders: viewFolders, files: viewFiles, mapping };
}
