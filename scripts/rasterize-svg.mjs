import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const FONT_CANDIDATES = [
  "C:/Windows/Fonts/segoeui.ttf",
  "C:/Windows/Fonts/segoeuib.ttf",
  "C:/Windows/Fonts/seguisb.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];

export function rasterizeSvg(svg, width) {
  const fontFiles = FONT_CANDIDATES.filter((file) => existsSync(file));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontFiles,
      loadSystemFonts: true,
      defaultFontFamily: "Segoe UI",
    },
  });
  return resvg.render().asPng();
}
