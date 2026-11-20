"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { BriefFile } from "../lib/deseret-producer-brief";
import { FileAudio, FileImage } from "./DirectFileMedia";
import { directTransferEnabled } from "../lib/direct-upload-client";

export function briefMediaKind(file: BriefFile) {
  const mime = file.mimeType?.split(";")[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") {
    if (/^image\/(?:jpeg|png|webp|gif|avif|bmp)$/.test(mime)) return "image";
    if (mime.startsWith("audio/")) return "audio";
    return null;
  }
  if (/\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name)) return "image";
  if (/\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|aiff?)$/i.test(file.name)) return "audio";
  return null;
}

function ImageViewer({ src, name, zh, close }: { src: string; name: string; zh: boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const center = useRef({ x: .5, y: .5 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  function resize(next: number) {
    const node = viewport.current;
    if (node) center.current = {
      x: (node.scrollLeft + node.clientWidth / 2) / node.scrollWidth,
      y: (node.scrollTop + node.clientHeight / 2) / node.scrollHeight,
    };
    setZoom(next);
  }
  useLayoutEffect(() => {
    const node = viewport.current;
    if (node) {
      node.scrollLeft = node.scrollWidth * center.current.x - node.clientWidth / 2;
      node.scrollTop = node.scrollHeight * center.current.y - node.clientHeight / 2;
    }
  }, [zoom]);
  function dismiss() {
    dialog.current?.close();
    close();
  }
  return <dialog ref={dialog} className="deseret-image-viewer" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header>
      <strong id={title}>{name}</strong>
      <div className="deseret-image-tools">
        <button type="button" disabled={zoom === 1} aria-label={zh ? "缩小图片" : "Zoom out"} title={zh ? "缩小图片" : "Zoom out"} onClick={() => resize(zoom - .5)}>−</button>
        <output aria-live="polite">{zoom * 100}%</output>
        <button type="button" disabled={zoom === 4} aria-label={zh ? "放大图片" : "Zoom in"} title={zh ? "放大图片" : "Zoom in"} onClick={() => resize(zoom + .5)}>+</button>
        <button type="button" disabled={zoom === 1} onClick={() => resize(1)}>{zh ? "适应窗口" : "Fit to window"}</button>
        <button type="button" onClick={dismiss}>{zh ? "关闭" : "Close"}</button>
      </div>
    </header>
    {/* The scrollable image needs a keyboard focus target for panning at higher zoom. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    <div className="deseret-image-viewport" ref={viewport} tabIndex={0} role="region" aria-label={name}>
      {failed ? <p role="alert">{zh ? "图片无法预览，可下载原文件查看。" : "Preview unavailable. Download the original image to view it."}</p> :
        <FileImage className="deseret-image-full" style={{width: zoom * 100 + "%", height: zoom * 100 + "%"}} src={src} alt={name} onError={() => setFailed(true)} />}
    </div>
  </dialog>;
}

export default function DeseretBriefMedia({ kind, version, name, zh }: { kind: "image" | "audio"; version: string; name: string; zh: boolean }) {
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = "/api/files?id=" + encodeURIComponent(version);
  if (!directTransferEnabled()) return <span>{zh ? "当前连接无法预览附件。" : "Attachment preview is unavailable on this connection."}</span>;
  if (kind === "audio") return <>
    <FileAudio controls preload="metadata" src={src} aria-label={name}
      onPlay={event => {
        event.currentTarget.closest(".deseret-producer-brief")?.querySelectorAll("audio").forEach(other => {
          if (other !== event.currentTarget) other.pause();
        });
      }} onError={() => setFailed(true)} />
    {failed && <span role="alert">{zh ? "音频无法播放，可下载原文件试听。" : "Playback unavailable. Download the original audio to listen."}</span>}
  </>;
  const label = zh ? "查看大图" : "Enlarge image";
  return <>
    <button type="button" className="deseret-image-thumb" aria-haspopup="dialog" aria-label={label + " · " + name} onClick={() => setOpened(true)}>
      {!failed && <FileImage src={src} loading="lazy" alt="" onError={() => setFailed(true)} />}
      <span>{label}</span>
    </button>
    {opened && <ImageViewer src={src} name={name} zh={zh} close={() => setOpened(false)} />}
  </>;
}
