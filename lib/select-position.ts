/** Keep a custom menu beside its trigger, bounded by the visible viewport. */
export function selectPosition(rect: { left: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }) {
  const gap = 6, margin = 12, desired = 320;
  const below = viewport.height - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const flipped = below < Math.min(desired, above) && above > below;
  const maxHeight = Math.max(0, Math.min(desired, flipped ? above : below));
  const width = Math.min(rect.width, Math.max(0, viewport.width - margin * 2));
  return { left: Math.max(margin, Math.min(rect.left, viewport.width - width - margin)), width, maxHeight,
    ...(flipped ? { bottom: viewport.height - rect.top + gap } : { top: rect.bottom + gap }) };
}
