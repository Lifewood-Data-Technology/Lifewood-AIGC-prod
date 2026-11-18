"use client";

import DialogSections from "./DialogSections";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type TaskFileChoice = {
  id: string;
  name: string;
  metadata: string;
  available: boolean;
};

/** Selection is a transaction: only Confirm changes the caller's selection. */
export default function TaskFilePicker({
  locale, title, files, selectedIds, multiple = false, onConfirm, onClose,
  renderCover, renderPreview,
}: {
  locale: "zh" | "en";
  title: string;
  files: TaskFileChoice[];
  selectedIds: string[];
  multiple?: boolean;
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
  renderCover: (id: string) => ReactNode;
  renderPreview: (id: string) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(() => [...selectedIds]);
  const [previewId, setPreviewId] = useState("");
  const [page, setPage] = useState(0);
  const previousPreview = useRef("");
  const zh = locale === "zh";
  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const effectivePage = Math.min(page, totalPages - 1);
  const visible = files.slice(effectivePage * pageSize, (effectivePage + 1) * pageSize);
  const preview = files.find(file => file.id === previewId);
  const validSelection = pending.every(id => files.some(file => file.id === id && file.available));

  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement;
    node?.showModal();
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    if (previousPreview.current && !previewId) {
      const restored = [...(dialog.current?.querySelectorAll<HTMLButtonElement>("[data-file-preview]") || [])]
        .find(button => button.dataset.filePreview === previousPreview.current);
      restored?.focus();
    }
    previousPreview.current = previewId;
  }, [previewId]);

  const toggle = (id: string) => {
    setPending(current => multiple
      ? current.includes(id) ? current.filter(value => value !== id) : [...current, id]
      : [id]);
  };

  return (
    <dialog ref={dialog} className="modal-card task-file-picker" aria-label={title}
      onCancel={event => {
        event.preventDefault();
        if (previewId) setPreviewId(""); else onClose();
      }}><DialogSections>
      <header className="task-file-picker-header">
        <div><h2>{preview ? preview.name : title}</h2>
          <p>{preview ? preview.metadata : zh ? "确认选择后应用到表单；取消不会修改原选择。" : "Confirm to apply your selection. Cancel keeps the original selection."}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => previewId ? setPreviewId("") : onClose()}>
          {previewId ? zh ? "返回文件选择" : "Back to files" : zh ? "取消" : "Cancel"}
        </button>
      </header>
      {previewId ? (
        <div className="task-file-picker-preview">
          {preview?.available ? renderPreview(previewId) : <p role="status">{zh ? "文件已不可用，请返回重新选择。" : "This file is no longer available. Return and choose another file."}</p>}
        </div>
      ) : (
        <>
          <div className="task-file-picker-grid" role="group" aria-label={title}>
            {visible.map(file => (
              <article key={file.id} className={`task-file-choice${pending.includes(file.id) ? " selected" : ""}`}>
                <button type="button" className="task-file-choice-select" disabled={!file.available}
                  aria-pressed={pending.includes(file.id)} onClick={() => toggle(file.id)}>
                  <span className="task-file-choice-cover">{renderCover(file.id)}</span>
                  <strong title={file.name}>{file.name}</strong>
                  <small>{file.metadata}</small>
                  <span className="task-file-choice-state">{pending.includes(file.id) ? zh ? "✓ 已选中" : "✓ Selected" : !file.available ? zh ? "不可用" : "Unavailable" : zh ? "选择" : "Select"}</span>
                </button>
                <button type="button" className="task-file-choice-preview" data-file-preview={file.id} disabled={!file.available} onClick={() => {
                  setPreviewId(file.id);
                }}>{zh ? "查看文件" : "View file"}</button>
              </article>
            ))}
            {!files.length && <p className="muted">{zh ? "当前任务暂无可选择的文件。" : "There are no available files for this task."}</p>}
          </div>
          <footer className="task-file-picker-footer">
            <span aria-live="polite">{zh ? `已选 ${pending.length} 个文件` : `${pending.length} file(s) selected`}</span>
            <div className="table-actions">
              {totalPages > 1 && <>
                <button type="button" className="secondary-button" disabled={effectivePage === 0} onClick={() => setPage(effectivePage - 1)}>{zh ? "上一页" : "Previous"}</button>
                <span>{effectivePage + 1} / {totalPages}</span>
                <button type="button" className="secondary-button" disabled={effectivePage === totalPages - 1} onClick={() => setPage(effectivePage + 1)}>{zh ? "下一页" : "Next"}</button>
              </>}
              <button type="button" className="primary-button" disabled={!validSelection} onClick={() => onConfirm(pending)}>{zh ? "确认选择" : "Confirm selection"}</button>
            </div>
          </footer>
          {!validSelection && <p role="alert">{zh ? "选中的文件已不可用，请重新选择。" : "A selected file is no longer available. Select an available file."}</p>}
        </>
      )}
    </DialogSections></dialog>
  );
}
