/**
 * The code of a new video in a project: one past the highest existing VID-n, skipping any code still in use. Counting
 * the videos would reuse a code after a video in the middle was deleted (the code is unique per project); codes
 * continue past VID-999 (VID-1000, ...).
 */
export function nextVideoCode(existing: readonly string[]) {
  let highest = BigInt(0);
  for (const code of existing) {
    const match = /^VID-(\d+)$/.exec(code);
    if (!match) continue;
    const sequence = BigInt(match[1]);
    if (sequence > highest) highest = sequence;
  }
  return `VID-${String(highest + BigInt(1)).padStart(3, "0")}`;
}
