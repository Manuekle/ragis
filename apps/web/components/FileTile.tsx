import { FileIcon } from "@untitledui/file-icons";

// Untitled UI file icons. Extension → icon type; unknown falls back to the blank page.
const TYPE: Record<string, string> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  md: "txt",
  markdown: "txt",
  txt: "txt",
  csv: "csv",
  html: "html",
  htm: "html",
  png: "png",
  jpg: "jpg",
  jpeg: "jpeg",
  mp3: "mp3",
  wav: "wav",
  m4a: "audio",
  ogg: "audio",
  flac: "audio",
};

export function FileTile({ ext, size = 40 }: { ext: string; size?: number }) {
  const type = TYPE[ext] ?? "empty";
  // Theme is switched by CSS (data-theme / prefers-color-scheme), so render both and show one.
  return (
    <span className="file-tile" aria-hidden="true">
      <FileIcon type={type} variant="solid" theme="light" size={size} className="fi-light" />
      <FileIcon type={type} variant="solid" theme="dark" size={size} className="fi-dark" />
    </span>
  );
}
