/** Stable stored values and existing localized labels, shared by forms and server validation. */
export const customerRegionOptions = [
  ["Malaysia", "马来西亚"],
  ["Singapore", "新加坡"],
  ["Thailand", "泰国"],
  ["Indonesia", "印度尼西亚"],
  ["Philippines", "菲律宾"],
  ["Vietnam", "越南"],
  ["United Kingdom", "英国"],
  ["Europe", "欧洲"],
  ["North America", "北美"],
  ["Greater China", "大中华区"],
  ["Hong Kong", "香港"],
  ["Greater Bay Area", "大湾区"],
  ["Global", "全球"],
  ["Other", "其他"],
] as const;

/** New Chinese aliases accepted by spreadsheet imports; other values retain existing validation. */
export function importedCustomerRegion(value: string) {
  const region = value.trim();
  return region === "香港" ? "Hong Kong" : region === "大湾区" ? "Greater Bay Area" : region;
}
