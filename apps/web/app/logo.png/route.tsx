import { ImageResponse } from "next/og";
import { LOGO_PATH } from "@/components/Logo";

export const dynamic = "force-static";

/**
 * The Ragis mark as a 512 × 512 PNG: the logo search engines show for the Organization
 * (structured data needs a raster image they can fetch) and the large icon in the web manifest.
 */
export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#fbfbfc" }}>
        <svg viewBox="222 200 806 809" width={330} height={330}>
          <path fill="#18181b" d={LOGO_PATH} />
        </svg>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
