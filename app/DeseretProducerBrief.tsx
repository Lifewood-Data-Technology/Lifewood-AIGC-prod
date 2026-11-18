"use client";
import { useState } from "react";
import { producerBriefSections, type BriefFile, type BriefRow } from "../lib/deseret-producer-brief";
import { downloadFileSet } from "../lib/browser-downloads";
import { LogIcon } from "./AdminLogControls";

export default function DeseretProducerBrief({ brief, files, locale }: {
  brief: unknown;
  files: BriefFile[];
  locale: "zh" | "en";
}) {
  const sections = producerBriefSections(brief, files, locale);
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

  function renderFile(file: BriefFile, index: number) {
    const label = zh ? `下载 ${file.name}` : `Download ${file.name}`;
    const downloadable = file.state === "ready" && Boolean(file.nativeVersionId);
    const awaiting = file.state === "pending" || file.state === "running";
    const status = awaiting ? (zh ? "待接收" : "Awaiting file") : (zh ? "暂不可用" : "Currently unavailable");
    return <li key={`${file.id}:${index}`}>
      {file.name}{!downloadable && ` · ${status}`}
      {downloadable && (
        <button type="button" className="icon-button" disabled={Boolean(downloading)} aria-busy={downloading === file.id || undefined}
          title={label} aria-label={label} onClick={() => void download(file)}>
          <LogIcon name="export" />
        </button>
      )}
    </li>;
  }

  function renderRows(rows: BriefRow[]) {
    return <dl>{rows.map(row => <div key={row.id}>
      {row.label && <dt>{row.label}</dt>}
      <dd className="deseret-production-script">
        {row.value}
        {row.files.length > 0 && <ul>{row.files.map(renderFile)}</ul>}
        {row.children.length > 0 && renderRows(row.children)}
      </dd>
    </div>)}</dl>;
  }

  const title = zh ? "已批准制作资料" : "Approved production brief";
  return <section className="pm-detail-card deseret-producer-brief" aria-label={title}>
    <h4>{title}</h4>
    {failed && <p role="alert">{zh ? "文件暂时无法下载，请刷新后重试。" : "The file could not be downloaded. Refresh and retry."}</p>}
    {!sections.length && <p>{zh ? "本版尚无可展示的制作资料。" : "This version contains no production information to display."}</p>}
    {sections.map((section, index) => <details key={section.id} open={index === 0}>
      <summary>{section.label}</summary>
      {renderRows(section.rows)}
    </details>)}
  </section>;
}
