"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Review media is user supplied. */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type RefObject } from 'react';
import {createPortal} from 'react-dom';
import { useVideoSource } from './DirectFileMedia';

type Props = Omit<ComponentPropsWithRef<'video'>, 'src' | 'ref'> & {
  src: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  locale: 'zh' | 'en';
  onFrameTime?: (seconds: number) => void;
  errorHost?: HTMLElement|null;
};

/** Keep network/decoder feedback visible only when playback actually fails; normal seeks/loading stay silent. */
export default function QualityVideoPlayer({ src, videoRef, locale, onLoadedMetadata, onTimeUpdate, onSeeking, onSeeked, onFrameTime, onPlay, errorHost, ...props }: Props) {
  const {read,buffer,buffered,unavailable,mediaSource}=useVideoSource(src,Boolean(props.controls));
  const {remember}=read;
  const [playbackFailed,setPlaybackFailed]=useState(false);
  const [attempt, setAttempt] = useState(0);
  const retrying = useRef(false);
  const resume = useRef<{ time: number; playing: boolean; rate: number } | null>(null);
  const mounted = useRef(true);
  const frameTime = useRef(onFrameTime);
  useLayoutEffect(() => { frameTime.current = onFrameTime; }, [onFrameTime]);
  const trackFrames = Boolean(onFrameTime);
  const zh = locale === 'zh';
  const failed = unavailable || playbackFailed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !trackFrames) return;
    if (typeof window.requestAnimationFrame !== 'function') return;
    let active = true, animation = 0;
    const animate = () => {
      animation = 0;
      if (!active || video.paused || video.ended) return;
      // Match the existing 25 fps playhead convention even for a 5/30/60 fps source.
      if (!video.seeking) frameTime.current?.(video.currentTime);
      animation = window.requestAnimationFrame(animate);
    };
    const playing = () => { if (!animation) animation = window.requestAnimationFrame(animate); };
    video.addEventListener('playing', playing);
    if (!video.paused) playing();
    return () => {
      active = false;
      if (animation) window.cancelAnimationFrame(animation);
      video.removeEventListener('playing', playing);
    };
  }, [attempt, mediaSource, trackFrames, videoRef]);
  const playable = (video: HTMLVideoElement) => {
    if (video.readyState >= 2 && !video.seeking) { setPlaybackFailed(false); }
  };
  const retry = async () => {
    if (retrying.current) return;
    retrying.current = true;
    const video = videoRef.current;
    if (video) resume.current = { time: video.currentTime, playing: !video.paused, rate: video.playbackRate };
    setPlaybackFailed(false);
    try {
      if (read.active && !await read.renew()) return;
      if(buffered)buffer.restart();
      if (mounted.current) setAttempt(value => value + 1);
    } finally { retrying.current = false; }
  };
  useEffect(()=>{
    if(mediaSource)return;
    const node=videoRef.current;if(node){if(node.readyState>0||!node.paused)node.pause();node.removeAttribute('src');if(node.readyState>0)node.load();}
  },[mediaSource,videoRef]);
  useEffect(()=>{const node=videoRef.current;return()=>{if(node){if(node.readyState>0||!node.paused)node.pause();node.removeAttribute('src');if(node.readyState>0)node.load();}};},[videoRef,attempt]);
  useEffect(()=>{if(!buffered)return;const save=()=>{if(videoRef.current)remember(videoRef.current);};window.addEventListener('pagehide',save);return()=>window.removeEventListener('pagehide',save);},[buffered,remember,videoRef]);
  const failure=failed?<div className="quality-playback-error" role="alert"><span>{zh?'视频暂时无法播放':'Video cannot be played right now'}</span><button type="button" onClick={()=>void retry()}>{zh?'重新加载视频':'Reload video'}</button></div>:null;
  return <><div className="quality-media-container">
    <video {...props} key={attempt} ref={videoRef} src={mediaSource} data-preview-cache={buffered?buffer.status:undefined} data-preview-loaded-bytes={buffered?buffer.progress.loadedBytes:undefined} data-preview-total-bytes={buffered?buffer.progress.totalBytes:undefined} crossOrigin={read.active ? 'anonymous' : props.crossOrigin}
      onLoadStart={() => setPlaybackFailed(false)}
      onPlay={event=>{buffer.fill();onPlay?.(event);}}
      onLoadedMetadata={event => {
        read.loaded(event);
        onLoadedMetadata?.(event);
        const saved = resume.current;
        if (saved) {
          resume.current = null;
          const video = event.currentTarget;
          video.currentTime = Number.isFinite(video.duration) ? Math.min(saved.time, video.duration) : saved.time;
          video.playbackRate = saved.rate;
          if (saved.playing) void video.play().catch(() => {});
        }
      }}
      onLoadedData={event => playable(event.currentTarget)}
      onCanPlay={event => playable(event.currentTarget)}
      onPlaying={event => playable(event.currentTarget)}
      onTimeUpdate={event => {
        // A waiting player can emit timeupdate with only its old frame available.
        if (event.currentTarget.readyState >= 3) playable(event.currentTarget);
        onTimeUpdate?.(event);
      }}
      onSeeking={event => { onSeeking?.(event); }}
      onSeeked={event => { playable(event.currentTarget); onSeeked?.(event); }}
      onError={event=>{if(buffer.canContinue()){read.remember(event.currentTarget);setPlaybackFailed(true);return;}setPlaybackFailed(!(buffer.failover(()=>read.remember(event.currentTarget))||read.onError(event)));}}
    />
  </div>{errorHost?createPortal(failure,errorHost):errorHost===undefined?failure:null}</>;
}
