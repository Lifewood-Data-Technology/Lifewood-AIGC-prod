/** Preserve the existing single-range semantics, including ignored malformed headers. */
export function requestedByteRange(header: string | null, size: number) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return null;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[2] && match[1] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start)
        return { invalid: true as const, start: 0, end: 0 };
    end = Math.min(end, size - 1);
    return { invalid: false as const, start, end };
}

