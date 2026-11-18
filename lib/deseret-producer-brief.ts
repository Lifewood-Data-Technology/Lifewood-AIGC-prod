// Client-safe projection of an already-authorized, frozen production brief.
// Published field IDs/choices remain authoritative; no URLs are fetched here.
export type BriefLocale = "zh" | "en";
type RecordValue = Record<string, unknown>;
export type BriefFile = { id: string; name: string; state?: string; nativeVersionId?: string };
export type BriefRow = { id: string; label: string; value: string; files: BriefFile[]; children: BriefRow[] };
export type BriefSection = { id: string; label: string; rows: BriefRow[] };
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown) => typeof v === "string" ? v : "";
const own = (o: RecordValue, key: string) => Object.hasOwn(o, key);
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
function visible(field: RecordValue, answers: RecordValue, root: RecordValue) {
  const condition = object(field.visibleWhen);
  if (!condition.fieldId) return true;
  const id = string(condition.fieldId);
  const value = own(answers, id) ? answers[id] : root[id];
  return String(value ?? "") === string(condition.equalsValue);
}

export function producerBriefSections(input: unknown, manifest: BriefFile[], locale: BriefLocale): BriefSection[] {
  const brief = object(input), form = object(brief.requirements), answers = object(form.answers);
  const defined = array(object(form.definition).groups);
  const useForm = defined.length > 0;
  const groups = useForm ? defined : Object.entries(producerFieldMap).map(([id, fields]) => ({ id, fields: fields.map(specField) }));
  const filesById = new Map(manifest.map(f => [f.id, f]));
  const used = new Set<string>();
  function rows(fields: unknown[], values: RecordValue, path: string, character?: RecordValue, depth = 0): BriefRow[] {
    if (depth > 2) return [];
    return fields.flatMap((raw, index) => {
      const field = object(raw), id = string(field.id), binding = string(field.binding);
      if (!visible(field, values, answers)) return [];
      if (!useForm && binding.startsWith("voice.") && binding !== "voice.narrationEnabled" && boundValue(brief,"voice.narrationEnabled") === false) return [];
      const value = useForm ? values[id] : boundValue(brief, binding, character);
      const blank = value === undefined || value === null || value === "" || Array.isArray(value) && !value.length;
      // Show receipt gaps only for fields included in this version and visible for the selected options.
      const highlightMissing = binding === "book.synopsis" || binding === "creative.characters" || binding === "character.referenceImages";
      if (blank && !highlightMissing) return [];
      const key = `${path}/${index}:${id}`;
      const spec = Object.values(producerFieldMap).flat().concat(characterFields).find(s => s[0] === binding);
      const label = spec && locale === "zh" && briefLabel(field.label,"zh") === spec[2] ? spec[1] : briefLabel(field.label,locale) || spec?.[locale === "zh" ? 1 : 2] || (locale === "zh" ? "制作要求" : "Requirement");
      const result: BriefRow = { id: key, label, value: "", files: [], children: [] };
      if (blank) {
        result.value = locale === "zh" ? "本版未提供" : "Not supplied in this version";
      } else if (field.kind === "repeat") {
        result.children = array(value).map((item, n) => {
          const row = object(item), rowId = string(row._rowId) || string(row.id) || String(n + 1);
          return { id: `${key}/${n}:${rowId}`, label: `${label} ${n + 1}`, value: "", files: [], children: rows(array(field.fields), row, `${key}/${n}:${rowId}`, row, depth + 1) };
        });
      } else if (field.kind === "files") {
        result.files = array(value).map(item => {
          const reference = object(item), fileId = string(item) || string(reference.id);
          used.add(fileId);
          return filesById.get(fileId) || { id: fileId, name: string(reference.fileName) || (locale === "zh" ? "附件" : "Attachment"), state: "unavailable" };
        });
      } else {
        const choices = array(field.choices).length ? array(field.choices) : array(field.options);
        const display = (v: unknown): string => {
          if (typeof v === "boolean") return locale === "zh" ? v ? "是" : "否" : v ? "Yes" : "No";
          if (typeof v === "number") return String(v);
          if (typeof v !== "string") return "";
          const choice = choices.map(object).find(c => c.id === v || c.value === v);
          return briefLabel(choice?.label,locale) || v;
        };
        result.value = (Array.isArray(value) ? value : [value]).map(display).filter(Boolean).join("\n");
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
  const ungrouped = manifest.filter(f => !used.has(f.id));
  if (ungrouped.length) sections.push({ id: "attachments", label: titles.attachments[locale === "zh" ? 0 : 1], rows: [{ id: "attachments", label: "", value: "", files: ungrouped, children: [] }] });
  return sections;
}

/** Use bound answers when present, including explicit empty values; retain legacy snapshots. */
// Alternate paths are meaningful only in older briefs that did not bind this field.
export function producerBoundValues(input: unknown, binding: string, ...legacyAlternates: unknown[]): unknown[] {
  const brief = object(input), form = object(brief.requirements), answers = object(form.answers);
  for (const group of array(object(form.definition).groups)) {
    for (const raw of array(object(group).fields)) {
      const field = object(raw);
      if (field.binding === binding) return visible(field, answers, answers) ? [answers[string(field.id)]] : [];
    }
  }
  return [boundValue(brief, binding), ...legacyAlternates];
}

export function producerBoundValue(input: unknown, binding: string): unknown {
  return producerBoundValues(input, binding)[0];
}

export function producerDurationSeconds(brief: unknown): number | undefined {
  const value=producerBoundValue(brief,"book.videoDurationId");
  return typeof value === "string" && /^(15|30|45|60|90|120)s$/.test(value) ? Number(value.slice(0,-1)) : undefined;
}
