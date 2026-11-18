/** Call from a user gesture. Reject when copying was not confirmed by the browser. */
export async function copyText(value: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document.execCommand !== "function") throw new Error("Clipboard unavailable.");

  // Keep this path synchronous until copy completes, including on HTTP pages.
  const previous = document.activeElement;
  const field = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : null;
  const fieldSelection = field && field.selectionStart !== null && field.selectionEnd !== null
    ? { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? "none" } : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
  // A native modal makes the rest of the document inert; copy inside its scope.
  const container = previous?.closest('dialog[open],[role="dialog"]') || document.querySelector("dialog[open]") || document.body;
  try {
    container.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was not confirmed.");
  } finally {
    textarea.value = "";
    textarea.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
    }
    // Chrome's document Selection restoration can reset an input's selection.
    if (fieldSelection && field?.isConnected) field.setSelectionRange(fieldSelection.start, fieldSelection.end, fieldSelection.direction);
  }
}
