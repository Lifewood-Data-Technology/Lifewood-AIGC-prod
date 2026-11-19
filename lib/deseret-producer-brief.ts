// Client-safe projection of an already-authorized, frozen production brief.
// Published field IDs/choices remain authoritative; no URLs are fetched here.
export type BriefLocale = "zh" | "en";
type RecordValue = Record<string, unknown>;
export type BriefFile = { id: string; name: string; mimeType?: string; purpose?: string; state?: string; nativeVersionId?: string };
export type BriefRow = { id: string; label: string; value: string; files: BriefFile[]; children: BriefRow[]; binding?: string; missingRequired?: boolean };
export type BriefSection = { id: string; label: string; rows: BriefRow[] };
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown) => typeof v === "string" ? v : "";

export function briefLabel(value: unknown, locale: BriefLocale) {
  const v = object(value);
  return string(v[locale === "zh" ? "zhCN" : "enUS"]) || string(v[locale]) || string(v.enUS) || string(v.zhCN) || string(value);
}
const titles: Record<string, [string, string]> = {
  book: ["书籍信息", "Book information"], source: ["原文与素材", "Source & materials"],
  characters: ["人物", "Characters"], visuals: ["画面风格", "Visuals"],
  narration: ["旁白与声音", "Narration & voices"], direction: ["创作方向与参考", "Creative direction & references"],
  requirements: ["制作要求", "Production requirements"], attachments: ["其他附件", "Other attachments"],
};
type FieldSpec = [binding: string, zh: string, en: string, kind?: string];
const filePurposes = new Map<string, [string, string]>([
  ["book-cover", ["书籍封面", "Book cover"]],
  ["book-cover-back", ["封底", "Back cover"]],
  ["focus-manuscript", ["重点章节", "Selected chapters"]],
  ["author-voice", ["本人录音", "Author voice recording"]],
  ["manuscript", ["书籍正文或节选", "Book text or excerpt"]],
  ["supplemental-images", ["补充照片", "Supplemental photos"]],
  ["character-reference", ["人物参考图", "Character references"]],
  ["style-reference", ["风格参考图", "Visual style references"]],
  ["sample-video", ["示例视频", "Example videos"]],
  ["sample-image", ["示例图片", "Example images"]],
  ["moodboard", ["风格参考拼图", "Visual inspiration board"]],
  ["competitor", ["竞品参考", "Competitive references"]],
  ["scene-notes", ["场景说明", "Scene notes"]],
  ["dos-donts", ["制作注意事项", "Do and don’t notes"]],
]);

function filesByPurpose(files: BriefFile[], locale: BriefLocale, path: string): BriefRow[] {
  const groups = new Map<string, BriefFile[]>();
  for (const file of files) {
    const category = (file.purpose ?? "").replace(/^form-/, "");
    const purpose = filePurposes.has(category) ? category : "";
    const group = groups.get(purpose);
    if (group) group.push(file);
    else groups.set(purpose, [file]);
  }
  return Array.from(groups, ([purpose, items]) => ({
    id: `${path}/${purpose}`, label: filePurposes.get(purpose)?.[locale === "zh" ? 0 : 1] || "",
    value: "", files: items, children: [],
  }));
}
// Fallback for historical handoffs without a versioned form, not a new form definition.
export const producerFieldMap: Record<string, FieldSpec[]> = {
  book: [["book.title","书名","Book title"],["book.authorName","作者","Author"],["book.subtitle","副标题","Subtitle"],["book.synopsis","内容简介","Synopsis"],["book.sellingPoint","核心卖点","Selling point"],["book.genreId","类型","Genre"],["book.contentLanguageId","内容语言","Content language"],["book.videoDurationId","视频时长","Video duration"],["book.customVideoDuration","自定义时长","Custom video duration"],["book.sourceAssets","书籍附件","Book files","files"]],
  source: [["direction.manuscript","原文","Manuscript"]],
  characters: [["creative.characters","人物","Characters","repeat"]],
  visuals: [["creative.visualStyleId","视觉风格","Visual style"],["creative.moodTagIds","氛围","Mood"],["creative.imageStyleTagIds","图像风格","Image style"],["creative.paceTagIds","节奏","Pace"],["creative.styleReferenceImageUrls","视觉参考链接","Visual reference links"],["creative.styleReferenceImages","风格参考图片","Style reference images","files"]],
  narration: [["voice.narrationEnabled","旁白","Narration"],["voice.customVoiceDescription","声音描述","Voice description"],["voice.pronunciationNotes","发音说明","Pronunciation notes"],["voice.contentLanguageId","旁白语言","Narration language"],["voice.narrationToneId","旁白语气","Narration tone"],["voice.speechRateId","语速","Speech rate"],["voice.voiceGenderId","声音性别","Voice gender"],["voice.voiceAgeId","声音年龄","Voice age"],["voice.accentId","口音","Accent"],["voice.emotionStyleId","声音情绪","Voice emotion"],["voice.selectedVoiceIds","参考声音","Reference voices"],["voice.preferredVoiceId","首选声音","Preferred voice"]],
  direction: [["book.publishingPlatformIds","发布平台","Publishing platforms"],["references.assets","参考附件","Reference files","files"],["references.competitorUrls","参考链接","Reference links"],["direction.videoPurpose","视频用途","Video purpose"],["direction.coreMessage","核心信息","Core message"],["direction.requiredScenes","指定情节","Required scenes"],["direction.authorPreferences","作者偏好","Author preferences"],["direction.musicMood","音乐氛围","Music mood"],["direction.avoidContent","避免内容","Content to avoid"],["direction.closingMessage","结尾信息","Closing message"],["direction.vision","创作构想","Your vision"]],
  requirements: [["project.brandId","品牌","Brand"],["project.projectName","项目名称","Project name"],["project.videoGoalId","视频目标","Video goal"],["project.audienceIds","受众","Audience"],["project.deadline","交期","Deadline"],["project.releaseDate","发布日期","Release date"],["project.brandAlignment","品牌要求","Brand alignment"],["project.conceptNotes","概念说明","Concept notes"],["project.distributionFormats","分发格式","Distribution formats"],["project.brandedOutro","品牌片尾","Branded outro"]],
};
const characterFields: FieldSpec[] = [["character.name","姓名","Name"],["character.roleTypeId","角色类型","Role type"],["character.storyRole","故事作用","Story role"],["character.personality","性格","Personality"],["character.appearance","外貌","Appearance"],["character.ageRangeId","年龄","Age range"],["character.genderId","性别","Gender"],["character.clothing","服装","Clothing"],["character.emotion","情绪","Emotion"],["character.voiceHint","声音描述","Voice description"],["character.referenceImageUrls","参考链接","Reference links"],["character.referenceImages","人物三视图及参考图","Character turnarounds and references","files"],["character.description","人物描述","Character description"]];
function boundValue(brief: RecordValue, binding: string, row?: RecordValue): unknown {
  const [section, key] = binding.split(".");
  const references = object(brief.voiceAndReferences);
  const root = section === "character" ? row : section === "direction" ? references.creativeDirection : section === "voice" ? references.voiceover : section === "references" ? references : brief[section];
  const value = object(root)[key];
  if (value !== undefined) return value;
  // Early signed handoffs used these flat keys before the versioned form was introduced.
  if (binding === "book.synopsis") return brief.story;
  if (binding === "creative.characters") return brief.characters;
  if (binding === "direction.coreMessage") return object(brief.project).coreMessage;
  return undefined;
}
function specField([binding, zhCN, enUS, kind = "text"]: FieldSpec): RecordValue {
  return { id: binding, binding, label: { zhCN, enUS }, kind, ...(kind === "repeat" ? { fields: characterFields.map(specField) } : {}) };
}
function visible(field: RecordValue, answers: RecordValue) {
  const condition = object(field.visibleWhen);
  if (!condition.fieldId) return true;
  const id = string(condition.fieldId);
  const value = answers[id];
  return String(value ?? "") === string(condition.equalsValue);
}

function publishedField(groups: unknown[], binding: string) {
  for (const group of groups) {
    const field = array(object(group).fields).map(object).find(item => item.binding === binding);
    if (field) return field;
  }
}

export function versionedProductionLanguage(input: unknown): string | undefined {
  const brief = object(input);
  if (brief.requirements == null) return undefined; // Prior handoffs carried only the native task language.
  const form = object(brief.requirements), answers = object(form.answers);
  const field = publishedField(array(object(form.definition).groups), "book.contentLanguageId");
  if (field) return visible(field, answers) && brief.publisherProductionLanguage == null ? string(answers[string(field.id)]) : "";
  return string(brief.publisherProductionLanguage);
}

// A versioned handoff authorizes only the files referenced by its active answers.
export function approvedFileIds(input: unknown): Set<string> | undefined {
  const form = object(input).requirements;
  if (form == null) return undefined;
  const ids = new Set<string>();
  function collect(fields: unknown[], values: RecordValue) {
    for (const entry of fields) {
      const field = object(entry);
      if (!visible(field, values)) continue;
      const items = array(values[string(field.id)]);
      if (field.kind === "repeat") {
        for (const row of items) collect(array(field.fields), object(row));
      } else if (field.kind === "files") {
        for (const item of items) {
          const id = string(item) || string(object(item).id);
          if (id) ids.add(id);
        }
      }
    }
  }
  const {definition, answers} = object(form);
  for (const group of array(object(definition).groups)) collect(array(object(group).fields), object(answers));
  return ids;
}

// Use only identities from this approved revision. Row labels and array positions are not identities.
export function approvedSceneCharacters(input: unknown): { id: string; name: string }[] {
  const brief = object(input), form = object(brief.requirements), answers = object(form.answers);
  const groups = array(object(form.definition).groups);
  const cast = publishedField(groups, "creative.characters");
  const nameField = array(cast?.fields).map(object).find(field => field.binding === "character.name");
  const rows = groups.length ? (cast && visible(cast, answers) ? answers[string(cast.id)] : []) : boundValue(brief, "creative.characters");
  const characters = array(rows).map(item => {
    const row = object(item);
    const id = groups.length ? string(row._rowId) : string(row.id);
    const name = groups.length ? (nameField && visible(nameField, row) ? string(row[string(nameField.id)]) : "") : string(row.name);
    return {id, name: name.trim()};
  });
  return characters.filter(({id, name}) => /^[a-zA-Z0-9_-]{1,100}$/.test(id) && name.length > 0 &&
    name.length <= 1000 && characters.filter(row => row.id === id).length === 1);
}

// Future compound answers are user data. Render ordinary values as text, never as media links.
function structuredAnswer(value: unknown, locale: BriefLocale, depth = 0): string {
  const check = locale === "zh" ? "请核对原始资料" : "Check source material";
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (depth >= 3) return check;
  const entries = Object.entries(value).filter(([key]) => !/^_|^(?:objectkey|storageprofileid|url|token|secret|password|accesskey|signature)/i.test(key));
  const parts = entries.slice(0, 30).map(([key, item]) => {
    const content = structuredAnswer(item, locale, depth + 1);
    return content && (Array.isArray(value) ? content : `${key}: ${content}`);
  }).filter(Boolean);
  if (entries.length > 30 || !parts.length) parts.push(check);
  return parts.join(" · ");
}

export function producerBriefSections(input: unknown, manifest: BriefFile[], locale: BriefLocale): BriefSection[] {
  const brief = object(input), form = object(brief.requirements), answers = object(form.answers);
  const defined = array(object(form.definition).groups);
  const useForm = defined.length > 0;
  const durationField = publishedField(defined, "book.videoDurationId");
  const selectedDuration = useForm
    ? durationField && visible(durationField, answers) && answers[string(durationField.id)]
    : boundValue(brief, "book.videoDurationId");
  const groups = useForm ? defined : Object.entries(producerFieldMap).map(([id, fields]) => ({ id, fields: fields.map(specField) }));
  const filesById = new Map(manifest.map(f => [f.id, f]));
  const used = new Set<string>();
  function rows(fields: unknown[], values: RecordValue, path: string, character?: RecordValue, depth = 0): BriefRow[] {
    if (depth > 2) return [];
    return fields.flatMap((raw, index) => {
      const field = object(raw), id = string(field.id), binding = string(field.binding);
      if (field.kind === "media") return [];
      if (!visible(field, values)) return [];
      if (binding === "book.customVideoDuration" && typeof selectedDuration === "string" && selectedDuration && selectedDuration !== "custom") return [];
      if (!useForm && binding.startsWith("voice.") && binding !== "voice.narrationEnabled" && boundValue(brief,"voice.narrationEnabled") === false) return [];
      const value = useForm ? values[id] : boundValue(brief, binding, character);
      const blank = value === undefined || value === null || typeof value === "string" && !value.trim() || Array.isArray(value) && !value.length;
      // Show receipt gaps only for fields included in this version and visible for the selected options.
      const highlightMissing = binding === "book.synopsis" || binding === "creative.characters" || binding === "character.referenceImages";
      if (blank && !highlightMissing && field.required !== true) return [];
      const key = `${path}/${index}:${id}`;
      const spec = Object.values(producerFieldMap).flat().concat(characterFields).find(s => s[0] === binding);
      const label = spec && locale === "zh" && briefLabel(field.label,"zh") === spec[2] ? spec[1] : briefLabel(field.label,locale) || spec?.[locale === "zh" ? 1 : 2] || (locale === "zh" ? "制作要求" : "Requirement");
      const result: BriefRow = { id: key, binding, label, value: "", files: [], children: [] };
      if (blank) {
        result.missingRequired = field.required === true;
        result.value = locale === "zh" ? "本版未提供" : "Not supplied in this version";
      } else if (field.kind === "repeat") {
        result.children = array(value).map((item, n) => {
          const row = object(item), rowId = string(row._rowId) || string(row.id) || String(n + 1);
          const entryId = `${key}/${n}:${rowId}`;
          const children = rows(array(field.fields), row, entryId, row, depth + 1);
          const name = binding === "creative.characters" ? children.find(child => child.binding === "character.name" && !child.missingRequired) : undefined;
          return { id: entryId, label: name?.value || `${label} ${n + 1}`, value: "", files: [], children };
        });
      } else if (field.kind === "files") {
        result.files = array(value).map(item => {
          const reference = object(item), fileId = string(item) || string(reference.id);
          used.add(fileId);
          return filesById.get(fileId) || { id: fileId, name: string(reference.fileName) || (locale === "zh" ? "附件" : "Attachment"), state: "unavailable" };
        });
        if (!useForm && (binding === "book.sourceAssets" || binding === "references.assets")) {
          const items = array(value);
          const categorized = result.files.map((file, n) => ({ ...file, purpose: file.purpose || string(object(items[n]).categoryId) }));
          if (categorized.some(file => filePurposes.has(file.purpose))) {
            result.children = filesByPurpose(categorized, locale, key);
            result.files = [];
          }
        }
      } else {
        const choices = array(field.choices).length ? array(field.choices) : array(field.options);
        const display = (v: unknown): string => {
          if (typeof v === "boolean") return locale === "zh" ? v ? "是" : "否" : v ? "Yes" : "No";
          if (typeof v === "number") return String(v);
          if (typeof v !== "string") return structuredAnswer(v, locale);
          const choice = choices.map(object).find(c => c.id === v || c.value === v);
          return briefLabel(choice?.label,locale) || v;
        };
        const selected = Array.isArray(value) ? value : [value];
        result.value = selected.map(display).filter(Boolean).join("\n");
        if (field.presentation === "audio" || field.presentation === "image" || binding === "project.videoGoalId") {
          const descriptions = choices.map(object).filter(choice => selected.includes(choice.id) && string(choice.description).trim());
          if (descriptions.length) {
            result.value = "";
            result.children = selected.map((item, n) => ({
              id: `${key}/choice/${n}`, label: display(item),
              value: string(descriptions.find(choice => choice.id === item)?.description), files: [], children: [],
            }));
          }
        }
      }
      return result.value || result.files.length || result.children.length ? [result] : [];
    });
  }
  const sections = groups.map((raw, i) => {
    const group = object(raw), id = string(group.id), title = titles[id];
    const publishedLabel = briefLabel(group.label,locale);
    const content = rows(array(group.fields), answers, `${i}:${id}`);
    if (!useForm && id === "narration" && !content.length) {
      content.push({ id: "legacy-narration", label: "", value: locale === "zh" ? "本版未提供声音设定。" : "No voice settings were provided in this version.", files: [], children: [] });
    }
    return { id: `${i}:${id}`, label: title && (!publishedLabel || publishedLabel === title[1]) ? title[locale === "zh" ? 0 : 1] : publishedLabel || titles.requirements[locale === "zh" ? 0 : 1], rows: content };
  }).filter(s => s.rows.length);
  const productionLanguage = string(brief.publisherProductionLanguage);
  if (productionLanguage) {
    const row: BriefRow = {id:"publisher-production-language", binding:"publisherProductionLanguage",
      label: locale === "zh" ? "出版社指定的制作语言" : "Publisher-selected production language",
      value: productionLanguage, files:[], children:[]};
    const requirements = sections.find(section => section.id.endsWith(":requirements"));
    if (requirements) requirements.rows.push(row);
    else sections.push({id:"handoff-instructions", label:locale === "zh" ? "交接要求" : "Handoff instructions", rows:[row]});
  }
  const ungrouped = brief.requirements == null ? manifest.filter(f => !used.has(f.id)) : [];
  if (ungrouped.length) sections.push({ id: "attachments", label: titles.attachments[locale === "zh" ? 0 : 1], rows: filesByPurpose(ungrouped, locale, "attachments") });
  return sections;
}

// Use the same visible, localized rows as the approved form, including its choice
// labels. A platform list and an unrelated list of sizes do not establish pairs.
const intakeBindings = [
  "project.videoGoalId", "project.audienceIds", "direction.videoPurpose", "direction.coreMessage",
  "book.publishingPlatformIds", "project.distributionFormats", "book.videoDurationId",
  "book.customVideoDuration", "book.contentLanguageId", "publisherProductionLanguage", "project.deadline", "project.releaseDate",
  "project.brandId", "direction.closingMessage", "project.brandedOutro",
];

export function leadIntakeSummary(sections: BriefSection[], brief: unknown) {
  const fields = sections.flatMap(section => section.rows);
  const duration = producerBoundValue(brief, "book.videoDurationId");
  const facts = intakeBindings
    .filter(binding => binding !== "book.customVideoDuration" || duration === "custom")
    .flatMap(binding => fields.filter(row => row.binding === binding && !row.missingRequired));
  const missing: string[] = [];
  function collectMissing(rows: BriefRow[], path: string[]) {
    for (const row of rows) {
      const context = row.label ? [...path, row.label] : path;
      if (row.missingRequired) missing.push(context.join(" › "));
      if (row.children.length) collectMissing(row.children, context);
    }
  }
  for (const section of sections) collectMissing(section.rows, [section.label]);
  const selected = array(producerBoundValue(brief, "book.publishingPlatformIds")).map(string).filter(Boolean);
  const formats = producerBoundValue(brief, "project.distributionFormats");
  const form = object(object(brief).requirements);
  const field = publishedField(array(object(form.definition).groups), "book.publishingPlatformIds");
  const choices = array(field?.choices).map(object);
  const specifications = typeof formats === "string" ? formats : array(formats).map(entry => {
    const row = object(entry);
    return [string(row.platform), string(row.dimensions) || string(row.ratio)].join(" ");
  }).join("\n");
  // Recognize only a named platform immediately followed by an explicit ratio or dimensions.
  // Unrecognized free text stays visible verbatim for the lead to check against the brief.
  const namesWithSizes = Array.from(specifications.matchAll(/(?:^|[\n;,；，、·])\s*([^\n;,；，、·:：=]+?)[ \t,:：，=–—-]+\d+\s*[:：x×]\s*\d+(?:\s*px)?\s*(?=$|[\n;,；，、·])/gi),
    match => match[1].trim().toLowerCase());
  const checkPlatformSizes = selected.length > 1 && selected.some(id => {
    const label = choices.find(choice => choice.id === id)?.label;
    return ![id, briefLabel(label, "zh"), briefLabel(label, "en")].some(name => namesWithSizes.includes(name.toLowerCase()));
  });
  return { facts, missing, checkPlatformSizes };
}

/** Use bound answers when present, including explicit empty values; retain legacy snapshots. */
// Alternate paths are meaningful only in older briefs that did not bind this field.
export function producerBoundValues(input: unknown, binding: string, ...legacyAlternates: unknown[]): unknown[] {
  const brief = object(input), form = object(brief.requirements), answers = object(form.answers);
  const field = publishedField(array(object(form.definition).groups), binding);
  if (field) return visible(field, answers) ? [answers[string(field.id)]] : [];
  if (brief.requirements != null && ["book.videoDurationId", "book.publishingPlatformIds", "project.distributionFormats"].includes(binding)) return [];
  return [boundValue(brief, binding), ...legacyAlternates];
}

export function producerBoundValue(input: unknown, binding: string): unknown {
  return producerBoundValues(input, binding)[0];
}

export function producerDurationSeconds(brief: unknown): number | undefined {
  const value=producerBoundValue(brief,"book.videoDurationId");
  return typeof value === "string" && /^(15|30|45|60|90|120)s$/.test(value) ? Number(value.slice(0,-1)) : undefined;
}
