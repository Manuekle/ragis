"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { IconSpinner } from "./icons";

interface Segment {
  chunk_id: string;
  text: string;
  t_start: number;
  t_end: number;
  speakers: string[];
}
interface Line {
  at: number;
  speaker: string;
  text: string;
}

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

// A transcript line is stored as "[mm:ss] Speaker 1: text" (or "[h:mm:ss] …", speaker optional).
const LINE = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s*(?:(Hablante \d+):\s*)?(.*)$/;

function parseLines(segments: Segment[]): Line[] {
  const out: Line[] = [];
  for (const seg of segments) {
    for (const raw of seg.text.split("\n")) {
      const m = LINE.exec(raw);
      if (!m) {
        if (raw.trim()) out.push({ at: seg.t_start, speaker: "", text: raw.trim() });
        continue;
      }
      const at = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      out.push({ at, speaker: (m[4] ?? "").replace("Hablante", "Speaker"), text: m[5] ?? "" });
    }
  }
  return out;
}

/** Recording player with its transcript. Clicking a line plays from there; the line being spoken is highlighted. */
export default function AudioView({ src, orgId, documentId, versionId, title, startAt }: { src: string; orgId: string; documentId: string; versionId: string; title: string; startAt?: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(startAt ?? 0);

  useEffect(() => {
    let live = true;
    api<{ segments: Segment[] }>(`organizations/${orgId}/documents/${documentId}/versions/${versionId}/transcript`)
      .then((r) => live && setSegments(r.segments))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [orgId, documentId, versionId]);

  const lines = useMemo(() => parseLines(segments ?? []), [segments]);
  // Last line that has already started.
  let active = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i]!.at <= now + 0.25) active = i;

  // Open at the cited moment (does not autoplay: browsers block it and it would surprise people).
  useEffect(() => {
    const el = audio.current;
    if (!el || startAt == null) return;
    const seek = () => {
      el.currentTime = startAt;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
    return () => el.removeEventListener("loadedmetadata", seek);
  }, [startAt, src]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[aria-current='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function play(at: number) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = at;
    setNow(at);
    void el.play().catch(() => undefined);
  }

  return (
    <div className="audio-view">
      <div className="audio-player">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript below is the text alternative */}
        <audio ref={audio} src={src} controls preload="metadata" aria-label={`Recording: ${title}`} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
      </div>
      {failed ? (
        <p className="audio-empty">The transcript couldn't be loaded. You can still listen to the recording.</p>
      ) : segments === null ? (
        <p className="audio-empty" aria-busy="true">
          <IconSpinner size={18} />
        </p>
      ) : lines.length === 0 ? (
        <p className="audio-empty">This recording has no transcript.</p>
      ) : (
        <ol ref={list} className="transcript" aria-label="Transcript">
          {lines.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <button type="button" className="transcript-line" aria-current={i === active} onClick={() => play(l.at)} aria-label={`Play from ${clock(l.at)}`}>
                <span className="mono t">{clock(l.at)}</span>
                <span>
                  {l.speaker && <strong>{l.speaker} </strong>}
                  {l.text}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="audio-foot">Transcript written by AI. Speaker numbers tell voices apart; they are not names.</p>
    </div>
  );
}
