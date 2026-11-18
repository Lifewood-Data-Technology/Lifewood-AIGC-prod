import {PublicError} from "./security-controls";

/** Business display text is not a folder/path segment. Storage keeps its separate sanitization. */
export function validBusinessTitle(value: string) {
  const name = value.trim();
  const hasControl = Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
  if (!name || name.length > 80 || name === "." || name === ".." || hasControl)
    throw new PublicError("Business title must contain 1–80 characters without control characters or a standalone dot path.");
  return name;
}
