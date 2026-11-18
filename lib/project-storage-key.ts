/** Readable locations apply only to new manual-test project uploads. */
export function projectStorageKey(input: {
  environment: string | undefined; legacyKey: string; folderNames: string[];
  fileId: string; objectId: string; version?: number; originalName: string; extension: string;
}) {
  if (!['test','audit'].includes(input.environment||'')) return input.legacyKey;
  const segment = (value: string, bytes: number) => {
    const clean = Array.from(value.normalize('NFC'), char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\' ? '_' : char).join('').trim().replace(/^\.+$|^\s*$/g, '_');
    let result = '';
    for (const char of clean) {
      if (Buffer.byteLength(result + char, 'utf8') > bytes) break;
      result += char;
    }
    return result || '_';
  };
  const folders = input.folderNames;
  // Bound the entire UTF-8 key, including the environment prefix, below S3's 1024 bytes.
  if (!folders.length || folders.length > 40) throw Error('Invalid project storage folder depth');
  const budget = Math.min(96, Math.floor(600 / folders.length));
  const path = folders.map(value => segment(value, budget)).join('/');
  const name = segment(input.originalName, 150);
  const filename = name.toLowerCase().endsWith(input.extension.toLowerCase()) ? name : name + input.extension;
  // Versions remain separate objects without adding directory levels.
  const suffix = input.version !== undefined && input.version > 1 ? `_v${String(input.version).padStart(3, '0')}` : '';
  const stem = filename.slice(0, filename.length - input.extension.length);
  return `${path}/${stem}${suffix}${input.extension}`;
}

export function canReuseProjectObject(environment: string | undefined) {
  return !['test','audit'].includes(environment||'');
}

/** Allocate a new readable object without overwriting an earlier upload.
 * Only an explicit conditional-write collision advances the suffix; network,
 * authentication and storage failures propagate without retrying the upload.
 */
export async function putReadableRevision<T>(
  environment: string | undefined,
  keyForVersion: (version: number) => string,
  firstVersion: number,
  put: (key: string) => Promise<T>,
) {
  for (let offset = 0; offset < 100; offset++) {
    const objectKey = keyForVersion(firstVersion + offset);
    try {
      return { objectKey, stored: await put(objectKey) };
    } catch (error) {
      if (!['test','audit'].includes(environment||'') || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
      if (offset === 99) throw error;
    }
  }
  throw Error('Readable object allocation exhausted');
}
