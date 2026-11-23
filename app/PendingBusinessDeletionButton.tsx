"use client";
import { useEffect, useState } from "react";
import { businessDeletionReceiptChanged, pendingBusinessDeletionTargets, type BusinessDeletionTarget } from "../lib/business-deletion-receipt";
import PermanentBusinessDeleteDialog from "./PermanentBusinessDeleteDialog";
import { useDraftOwner } from "./useLocalDraft";

type Props = { accessRevoked?: boolean; accessReviewKey?: string; kind: BusinessDeletionTarget["kind"]; locale: "zh" | "en"; onDeleted: (ids: string[]) => void; className?: string; label?: string };
type Selection = { owner: string; kind: BusinessDeletionTarget["kind"]; targets: BusinessDeletionTarget[] };

/** Recovery checks receipts saved by the current account. Opening it never starts a deletion. */
export default function PendingBusinessDeletionButton({ kind, locale, onDeleted, className = "secondary-button", accessReviewKey, accessRevoked, label }: Props) {
  const owner = useDraftOwner();
  const [pending, setPending] = useState<Selection>({ owner: "", kind, targets: [] });
  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => {
    const refresh = () => setPending({ owner, kind, targets: pendingBusinessDeletionTargets(owner, kind) });
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(businessDeletionReceiptChanged, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(businessDeletionReceiptChanged, refresh); };
  }, [owner, kind]);
  const targets = pending.owner === owner && pending.kind === kind ? pending.targets : [];
  const opened = selection?.owner === owner && selection.kind === kind ? selection : null;
  const showButton = targets.length > 0 || kind === "customer" || kind === "project";
  return <>{showButton && <button type="button" className={className} disabled={!targets.length} onClick={() => setSelection({ owner, kind, targets: pendingBusinessDeletionTargets(owner, kind) })}>{label ?? (locale === "zh" ? "核对删除任务" : "Review deletion")}</button>}
    {opened && opened.targets.length > 0 && <PermanentBusinessDeleteDialog accessReviewKey={accessReviewKey} accessRevoked={accessRevoked} targets={opened.targets} locale={locale} close={() => setSelection(null)} onDeleted={onDeleted} />}</>;
}
