/** Bounded JPEG container validation, not entropy decoding or malware scanning. */
export function hasJpegStructure(bytes: Uint8Array) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2, frame = false, scan = false, quantization = false, huffman = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    const end = offset + length;
    if (marker === 0xdb) quantization = length >= 67;
    if (marker === 0xc4) huffman = length >= 19;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 11 || bytes[offset + 2] !== 8 || length !== 8 + 3 * bytes[offset + 7]) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4], width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304) return false;
      frame = true;
    }
    offset = end;
    if (marker === 0xda) {
      if (!frame || !quantization || !huffman || length < 8 || length !== 6 + 2 * bytes[end - length + 2]) return false;
      let data = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { data++; offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { data++; offset += 2; continue; }
        break;
      }
      if (!data) return false;
      scan = true;
    }
  }
  return false;
}
