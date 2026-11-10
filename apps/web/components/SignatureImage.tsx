"use client";

import { useRef, useState } from "react";
import { IconSignature, IconUpload } from "@/components/icons";
import styles from "./signature-image.module.css";

export interface SavedSignature {
  id: string;
  label: string;
  image: string;
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function prepareImage(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB.");
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (!PNG_HEADER.every((byte, i) => header[i] === byte) && !(header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)) {
    throw new Error("Choose a PNG or JPEG image.");
  }

  const image = await createImageBitmap(file).catch(() => { throw new Error("This image could not be opened. Choose another PNG or JPEG."); });
  try {
    const ratio = Math.min(1, 512 / image.width, 192 / image.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the image.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  } finally {
    image.close();
  }
}

export function SignaturePreview({ image, name }: { image?: string; name?: string }) {
  return (
    <div className={styles.preview} aria-label="Signature preview">
      {image ? <img src={`data:image/png;base64,${image}`} alt="Signature preview" /> : name ? (
        <span className={styles.typed}>{name}</span>
      ) : (
        <span className={styles.placeholder}><IconSignature size={20} /> Your signature appears here</span>
      )}
    </div>
  );
}

export function SignatureUpload({ onImage, onReading, disabled, replacing }: {
  onImage: (image: string) => void;
  onReading: (reading: boolean) => void;
  disabled: boolean;
  replacing: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  async function select(file: File) {
    setError("");
    onReading(true);
    try {
      onImage(await prepareImage(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      onReading(false);
    }
  }

  return (
    <div className={styles.upload}>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        aria-label="Signature image file"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void select(file);
        }}
      />
      <div className="row">
        <button type="button" className="ghost small" disabled={disabled} onClick={() => input.current?.click()}>
          <IconUpload size={14} /> {replacing ? "Change image" : "Upload image"}
        </button>
        <small className="muted">PNG or JPG · up to 10 MB</small>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
    </div>
  );
}
