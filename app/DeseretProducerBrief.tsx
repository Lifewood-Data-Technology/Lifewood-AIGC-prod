"use client";
import { useState } from "react";
import { leadIntakeSummary, producerBriefSections, type BriefFile, type BriefRow } from "../lib/deseret-producer-brief";
import { downloadFileSet } from "../lib/browser-downloads";
import { LogIcon } from "./AdminLogControls";
import { MenuIcon } from "./MenuIcon";
import DeseretBriefMedia, { briefMediaKind } from "./DeseretBriefMedia";

export function DeseretBriefFiles({files, visible, locale}: {files: BriefFile[]; visible: boolean; locale: "zh" | "en"}) {
  const [downloading, setDownloading] = useState("");
  const [failed, setFailed] = useState(false);
  const zh = locale === "zh";
  async function download(file: BriefFile) {
    if (downloading || !file.nativeVersionId || file.state !== "ready") return;
    setDownloading(file.id);
    setFailed(false);
    try {
      await downloadFileSet([{ name: file.name, url: `/api/files?id=${encodeURIComponent(file.nativeVersionId)}&download=1` }], file.name, () => {});
    } catch {
      setFailed(true);
    } finally {
      setDownloading("");
    }
  }

  function renderFile(file: BriefFile, index: number, visible: boolean) {
    const label = zh ? `下载 ${file.name}` : `Download ${file.name}`;
    const downloadable = file.state === "ready" && Boolean(file.nativeVersionId);
    const awaiting = file.state === "pending" || file.state === "running";
    const status = awaiting ? (zh ? "待接收" : "Awaiting file") : (zh ? "暂不可用" : "Currently unavailable");
    const kind = visible && downloadable ? briefMediaKind(file) : null;
    return <li key={`${file.id}:${index}`} data-media={kind || undefined}>
      {kind && file.nativeVersionId && <div className="deseret-file-preview"><DeseretBriefMedia key={file.nativeVersionId} kind={kind} version={file.nativeVersionId} name={file.name} zh={zh} /></div>}
      <MenuIcon name="library" /><span>{file.name}{!downloadable && ` · ${status}`}</span>
      {downloadable && (
        <button type="button" className="icon-button" disabled={Boolean(downloading)} aria-busy={downloading === file.id || undefined}
          title={label} aria-label={label} onClick={() => void download(file)}>
          <LogIcon name="export" />
        </button>
      )}
    </li>;
  }

  return <>
    <ul className="deseret-brief-files">{files.map((file, index) => renderFile(file, index, visible))}</ul>
    {failed && <p role="alert">{zh ? "文件暂时无法下载，请刷新后重试。" : "The file could not be downloaded. Refresh and retry."}</p>}
  </>;
}

export default function DeseretProducerBrief({ brief, files, locale, leadView = false }: {
  brief: unknown;
  files: BriefFile[];
  locale: "zh" | "en";
  leadView?: boolean;
}) {
  const sections = producerBriefSections(brief, files, locale);
  const overview = leadView ? leadIntakeSummary(sections, brief) : undefined;
  const hasOverview = Boolean(overview && (overview.facts.length || overview.missing.length));
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const zh = locale === "zh";

  function renderRows(rows: BriefRow[], visible: boolean, className?: string) {
    return <dl className={className}>{rows.map(row => <div key={row.id}>
      {row.label && <dt>{row.label}</dt>}
      <dd className="deseret-production-script">
        {row.value}
        {row.files.length > 0 && <DeseretBriefFiles files={row.files} visible={visible} locale={locale} />}
        {row.children.length > 0 && renderRows(row.children, visible)}
      </dd>
    </div>)}</dl>;
  }

  const title = zh ? "已批准制作资料" : "Approved production brief";
  return <section className="pm-detail-card deseret-producer-brief" aria-label={title}>
    <h4>{title}</h4>
    {hasOverview && overview && <section className="deseret-intake-summary">
      <h5>{zh ? "接单要点" : "Production at a glance"}</h5>
      {overview.facts.length > 0 && renderRows(overview.facts, true, "deseret-intake-facts")}
      {overview.checkPlatformSizes && <p>{zh
        ? "请核对每个平台对应的尺寸。资料里没有写明时，可要求出版社补充，例如 Website 1920×1080、Instagram 1080×1920。"
        : "Check the size for each platform. If the brief is unclear, request the missing details, for example Website 1920×1080 and Instagram 1080×1920."}</p>}
      {overview.missing.length > 0 && <>
        <h5>{zh ? "本版缺少的必填资料" : "Required information missing from this version"}</h5>
        <ul>{overview.missing.map((field, index) => <li key={index}>{field}</li>)}</ul>
      </>}
    </section>}
    {!sections.length && <p>{zh ? "本版尚无可展示的制作资料。" : "This version contains no production information to display."}</p>}
    {sections.map((section, index) => {
      const open = openSections[section.id] ?? (!hasOverview && index === 0);
      return <details key={section.id} open={open} onToggle={event => {
        const next = event.currentTarget.open;
        if (next !== open) setOpenSections(previous => ({ ...previous, [section.id]: next }));
      }}>
        <summary>{section.label}</summary>
        {renderRows(section.rows, open)}
      </details>;
    })}
  </section>;
}
