"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useDraftRisk } from "./useLocalDraft";

/** Fields stay mounted between steps: no lost input and one final submission. */
export default function ProjectFormDialog({ locale, title, basic, requirements, planning, saving, onSubmit, onClose, externalValue, edit = false }: {
  locale: "zh" | "en"; title: ReactNode; basic: ReactNode; requirements: ReactNode; planning: ReactNode;
  saving: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>; onClose: () => void; externalValue: string; edit?: boolean;
}) {
  const zh = locale === "zh", [step, setStep] = useState(0), [dirty, setDirty] = useState(false);
  const [summary, setSummary] = useState({name:"",dueDate:"",requirements:""});
  const dialog = useRef<HTMLDialogElement>(null), form = useRef<HTMLFormElement>(null);
  const [initial] = useState(externalValue);
  const changed = dirty || initial !== externalValue;
  useDraftRisk(changed || saving);
  useEffect(() => { const node = dialog.current, previous = document.activeElement; node?.showModal(); return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const close = () => { if (!saving && (!changed || window.confirm(zh ? "尚未提交项目，离开会丢失本次填写和文件选择。仍要离开？" : "This project has not been submitted. Leave and discard these inputs and file selections?"))) onClose(); };
  const validate = (all: boolean) => {
    const fields = Array.from(form.current?.querySelectorAll<HTMLInputElement>("input,textarea,select") || []);
    const invalid = fields.find(field => (all || field.closest("[data-form-step]")?.getAttribute("data-form-step") === String(step)) && !field.checkValidity());
    if (!invalid) return true;
    const index = Number(invalid.closest("[data-form-step]")?.getAttribute("data-form-step") || 0);
    flushSync(() => setStep(index)); invalid.reportValidity(); invalid.focus(); return false;
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (saving) return;
    if (step < 2) { if (validate(false)) { const values = new FormData(event.currentTarget); setSummary({name:String(values.get("name") || ""),dueDate:String(values.get("dueDate") || ""),requirements:String(values.get("requirements") || "")}); setStep(step + 1); } return; }
    if (validate(true)) void onSubmit(event);
  };
  const labels = zh ? ["基本信息", "需求与资料", "视频规划与确认"] : ["Basic information", "Requirements & documents", "Videos & confirmation"];
  return <dialog ref={dialog} className="modal-card project-form-dialog" aria-label={zh ? "项目表单" : "Project form"} onCancel={event => { event.preventDefault(); close(); }}>
    <form ref={form} noValidate onSubmit={submit} onChangeCapture={() => setDirty(true)}>
      <header><h2>{title}</h2><button type="button" className="secondary-button" disabled={saving} aria-label={zh ? "关闭项目表单" : "Close project form"} onClick={close}>×</button></header>
      <ol className="project-form-steps" aria-label={zh ? "填写步骤" : "Form steps"}>{labels.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      <div className="project-form-body">
        <p className="project-form-help">{zh ? "标有 * 的内容必填。最后确认后才会提交。" : "Fields marked * are required. Nothing is submitted until final confirmation."}</p>
        <fieldset disabled={saving}>
          <section data-form-step="0" hidden={step !== 0} className="modal-grid">{basic}</section>
          <section data-form-step="1" hidden={step !== 1} className="modal-grid">{requirements}</section>
          <section data-form-step="2" hidden={step !== 2} className="modal-grid"><div className="full-field project-form-review"><strong>{summary.name}</strong><span>{zh ? "项目截止日期：" : "Project deadline: "}{summary.dueDate}</span><p>{summary.requirements}</p></div>{planning}<p className="full-field project-form-help">{zh ? "请核对视频名称、语言和截止日期。视频未单独指定截止日期时沿用项目日期。" : "Check video names, languages and deadlines. Videos without a separate deadline use the project deadline."}</p></section>
        </fieldset>
      </div>
      <footer><button type="button" className="secondary-button" disabled={saving} onClick={close}>{zh ? "取消" : "Cancel"}</button><div>{step > 0 && <button type="button" className="secondary-button" disabled={saving} onClick={() => setStep(step - 1)}>{zh ? "上一步" : "Back"}</button>}<button className="primary-button" type="submit" disabled={saving}>{saving ? zh ? "正在提交…" : "Submitting…" : step < 2 ? zh ? "下一步" : "Next" : edit ? zh ? "确认重新提交" : "Confirm resubmission" : zh ? "确认创建项目" : "Create project"}</button></div></footer>
    </form>
  </dialog>;
}
