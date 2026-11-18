export function captureDraftFields(form: HTMLFormElement, allowed: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of allowed) {
    const element = form.elements.namedItem(name);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    if (element instanceof HTMLInputElement && ["password", "file", "hidden"].includes(element.type)) continue;
    fields[name] = element.value;
  }
  return fields;
}
export function stringFields(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string" && item.length <= 100000));
}
