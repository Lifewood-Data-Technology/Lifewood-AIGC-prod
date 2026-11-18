import { Unzip, UnzipInflate, strFromU8 } from "fflate";
import {makeTextWorkbook} from "./text-workbook";
import { importedCustomerRegion } from "./customer-regions";

export const customerColumns = ["name", "legalName", "region", "industry", "contactName", "contactEmail", "contactPhone", "status", "ownerEmail", "lastContactAt", "notes"] as const;
export type CustomerImportRow = Record<string, string> & { sourceRow: string };
export type CustomerSheetRow = { values: CustomerImportRow; errors: string[] };
const aliases: Record<string, string> = Object.fromEntries([
  ...customerColumns.map(key => [key.toLowerCase(), key]),
  ["客户名称", "name"], ["客户", "name"], ["公司全称", "legalName"], ["区域", "region"], ["地区", "region"], ["行业", "industry"],
  ["联系人", "contactName"], ["联系人邮箱", "contactEmail"], ["邮箱", "contactEmail"], ["电话", "contactPhone"], ["状态", "status"],
  ["负责人邮箱", "ownerEmail"], ["最近联系", "lastContactAt"], ["最近联系时间", "lastContactAt"], ["备注", "notes"],
]);
export const customerSheetLimits = { bytes: 5 * 1024 * 1024, expanded: 16 * 1024 * 1024, rows: 500, entries: 128 };
const error = (code: string): never => { throw new Error(code); };
const text = (value: unknown) => value == null ? "" : String(value);

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function checksum(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
/** ZIP streaming alone accepts missing directories and does not verify CRCs. Validate the archive envelope too. */
function workbookDirectory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) return error("WORKBOOK_DAMAGED");
  const entries = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== entries || entries > customerSheetLimits.entries)
    return error("WORKBOOK_UNSUPPORTED");
  if (!entries || start + size !== end) return error("WORKBOOK_DAMAGED");
  const records = new Map<string, { size: number; crc: number }>();
  let offset = start, expanded = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return error("WORKBOOK_DAMAGED");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), length = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    if ((flags & 1) || ![0, 8].includes(method) || view.getUint16(offset + 34, true)) return error("WORKBOOK_UNSUPPORTED");
    if (offset + 46 + nameLength + extra + comment > end || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) return error("WORKBOOK_DAMAGED");
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    if (records.has(name) || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(name)) return error("WORKBOOK_UNSUPPORTED");
    if (local + 30 + localNameLength + localExtra + compressed > start || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || strFromU8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name)
      return error("WORKBOOK_DAMAGED");
    expanded += length;
    if (expanded > customerSheetLimits.expanded) return error("WORKBOOK_TOO_LARGE");
    records.set(name, { size: length, crc: view.getUint32(offset + 16, true) });
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) return error("WORKBOOK_DAMAGED");
  return records;
}

/** Parse ZIP incrementally and stop before accepting an oversized workbook. No macros or external fetches. */
function openWorkbook(bytes: Uint8Array) {
  const directory = workbookDirectory(bytes);
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0, count = 0;
  const unzip = new Unzip(file => {
    if (++count > customerSheetLimits.entries || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(file.name) || file.name in files) error("WORKBOOK_UNSUPPORTED");
    if (file.originalSize != null && file.originalSize > customerSheetLimits.expanded) error("WORKBOOK_TOO_LARGE");
    if (/vbaProject|externalLinks|embeddings|activeX/i.test(file.name)) error("WORKBOOK_UNSUPPORTED");
    files[file.name] = new Uint8Array();
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (failure, chunk, final) => {
      if (failure) error("WORKBOOK_DAMAGED");
      total += chunk.length; length += chunk.length;
      if (total > customerSheetLimits.expanded) { file.terminate(); error("WORKBOOK_TOO_LARGE"); }
      chunks.push(chunk);
      if (final) { const result = new Uint8Array(length); let offset = 0; for (const item of chunks) { result.set(item, offset); offset += item.length; } files[file.name] = result; }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 4096) unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  if (count !== directory.size) return error("WORKBOOK_DAMAGED");
  for (const [name, expected] of directory) {
    const content = files[name];
    if (!content || content.length !== expected.size || checksum(content) !== expected.crc) return error("WORKBOOK_DAMAGED");
  }
  return files;
}
function xml(bytes: Uint8Array | undefined) {
  if (!bytes) return error("WORKBOOK_DAMAGED");
  const source = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) error("WORKBOOK_UNSUPPORTED");
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length) error("WORKBOOK_DAMAGED");
  return parsed;
}
const elements = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS("*", name));
function worksheetMatrix(bytes: Uint8Array): Array<{ row: number; cells: string[] }> {
  const files = openWorkbook(bytes);
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith(".rels")) {
      if (elements(xml(content), "Relationship").some(rel => rel.getAttribute("TargetMode")?.toLowerCase() === "external")) error("WORKBOOK_EXTERNAL_LINK");
    }
    if (/^xl\/worksheets\/.*\.xml$/.test(name) && elements(xml(content), "f").length) error("WORKBOOK_FORMULA");
  }
  const types = xml(files["[Content_Types].xml"]);
  if (elements(types, "Override").some(item => /macro|vba/i.test(item.getAttribute("ContentType") || ""))) error("WORKBOOK_UNSUPPORTED");
  const workbook = xml(files["xl/workbook.xml"]);
  const sheet = elements(workbook, "sheet")[0];
  const relationId = sheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const relation = elements(xml(files["xl/_rels/workbook.xml.rels"]), "Relationship").find(item => item.getAttribute("Id") === relationId);
  const target = relation?.getAttribute("Target")?.replace(/^\//, "");
  if (!target || target.includes("..") || target.includes(":")) error("WORKBOOK_DAMAGED");
  const sheetPath = target!.startsWith("xl/") ? target! : `xl/${target}`;
  const shared = files["xl/sharedStrings.xml"] ? elements(xml(files["xl/sharedStrings.xml"]), "si").map(item => elements(item, "t").map(t => t.textContent || "").join("")) : [];
  const rows = elements(xml(files[sheetPath]), "row");
  if (rows.length > customerSheetLimits.rows + 1) error("TOO_MANY_ROWS");
  return rows.map((row, index) => {
    const cells: string[] = [];
    elements(row, "c").forEach((cell, cellIndex) => {
      const ref = cell.getAttribute("r") || "";
      const letters = ref.match(/^[A-Z]+/)?.[0];
      const position = letters ? [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cellIndex;
      if (position > 63 || position < 0) error("WORKBOOK_UNSUPPORTED");
      const value = elements(cell, "v")[0]?.textContent || "";
      const type = cell.getAttribute("t");
      if (type === "e") error("WORKBOOK_DAMAGED");
      cells[position] = type === "s" ? shared[Number(value)] ?? error("WORKBOOK_DAMAGED") : type === "inlineStr" ? elements(cell, "t").map(t => t.textContent || "").join("") : value;
    });
    return { row: Number(row.getAttribute("r")) || index + 1, cells };
  }).filter(row => row.cells.some(value => value?.trim()));
}
export function csvMatrix(source: string) {
  const matrix: Array<{ row: number; cells: string[] }> = [];
  let cells: string[] = [], cell = "", quoted = false, row = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' && quoted && source[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { cells.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      cells.push(cell); if (cells.some(value => value.trim())) matrix.push({ row, cells }); row++; cells = []; cell = "";
    } else cell += ch;
  }
  if (quoted) error("WORKBOOK_DAMAGED");
  cells.push(cell); if (cells.some(value => value.trim())) matrix.push({ row, cells });
  return matrix;
}
export async function parseCustomerSpreadsheet(file: Pick<File, "name" | "size" | "arrayBuffer" | "text">): Promise<CustomerImportRow[]> {
  if (file.size > customerSheetLimits.bytes) error("WORKBOOK_TOO_LARGE");
  if (!/\.(csv|xlsx)$/i.test(file.name)) error("WORKBOOK_UNSUPPORTED");
  let matrix;
  try { matrix = /\.csv$/i.test(file.name) ? csvMatrix(await file.text()) : worksheetMatrix(new Uint8Array(await file.arrayBuffer())); }
  catch (reason) { if (reason instanceof Error && /^[A-Z_]+$/.test(reason.message)) throw reason; return error("WORKBOOK_DAMAGED"); }
  if (matrix.length < 2) error("NO_CUSTOMER_ROWS");
  if (matrix.length > customerSheetLimits.rows + 1) error("TOO_MANY_ROWS");
  if (matrix.some(item => !Number.isSafeInteger(item.row) || item.row < 1 || item.row > 1_000_000) || new Set(matrix.map(item => item.row)).size !== matrix.length) error("WORKBOOK_DAMAGED");
  const headers = matrix[0].cells.map(value => aliases[value?.replace(/^\uFEFF/, "").trim().toLowerCase()]);
  if (!["name", "legalName", "region", "industry"].every(key => headers.includes(key))) error("MISSING_HEADERS");
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) error("DUPLICATE_HEADERS");
  return matrix.slice(1).map(({ row, cells }) => {
    const result: CustomerImportRow = { sourceRow: String(row) };
    headers.forEach((header, index) => {
      if (!header) return;
      const value = (cells[index] || "").trim();
      // CSV export protects phone numbers from spreadsheet formula interpretation.
      result[header] = /\.csv$/i.test(file.name) && header === "contactPhone" && /^'\+/.test(value) ? value.slice(1) : value;
    });
    if (result.region !== undefined) result.region = importedCustomerRegion(result.region);
    return result;
  });
}
export function makeCustomerWorkbook(rows: Record<string, unknown>[]) {
  return makeTextWorkbook([customerColumns, ...rows.map(row => customerColumns.map(key => text(row[key])))], "Customers");
}
export function customerCsv(rows: Record<string, unknown>[]) {
  const safeCell = (value: unknown) => { const raw = text(value); return `"${(/^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw).replaceAll('"', '""')}"`; };
  return "\uFEFF" + [customerColumns, ...rows.map(row => customerColumns.map(key => row[key]))].map(row => row.map(safeCell).join(",")).join("\r\n");
}
export function downloadCustomerSheet(rows: Record<string, unknown>[], format: "csv" | "xlsx", template = false) {
  const blob = format === "xlsx" ? new Blob([new Uint8Array(makeCustomerWorkbook(rows))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) : new Blob([customerCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `lifewood-customers-${template ? "template" : new Date().toISOString().slice(0, 10)}.${format}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
