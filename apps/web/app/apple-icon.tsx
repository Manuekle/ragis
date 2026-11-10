import { ImageResponse } from "next/og";
import { LOGO_PATH } from "@/components/Logo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#fbfbfc" }}>
        <svg viewBox="222 200 806 809" width={112} height={112}>
          <path fill="#18181b" d={LOGO_PATH} />
        </svg>
      </div>
    ),
    size,
  );
}
