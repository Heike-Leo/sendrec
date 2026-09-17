export interface TextTypography { fontFamily?: string; bold?: boolean; italic?: boolean }

// Controlled container files, reserved for a future renderer. No fonts are loaded here.
// CSS fallbacks are not pixel-identical to these files until shared webfonts exist.
export const TEXT_FONTS = [
  { id: "dejavu-sans", label: "Sans", css: '"DejaVu Sans", Arial, sans-serif', files: ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"] },
  { id: "dejavu-serif", label: "Serif", css: '"DejaVu Serif", Georgia, serif', files: ["DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-BoldItalic.ttf"] },
  { id: "dejavu-mono", label: "Mono", css: '"DejaVu Sans Mono", "Courier New", monospace', files: ["DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf", "DejaVuSansMono-Oblique.ttf", "DejaVuSansMono-BoldOblique.ttf"] },
] as const;

export function textTypography(value: TextTypography) {
  const font = TEXT_FONTS.find(font => font.id === (value.fontFamily === undefined ? "dejavu-sans" : value.fontFamily));
  if (!font || (value.bold !== undefined && typeof value.bold !== "boolean") ||
    (value.italic !== undefined && typeof value.italic !== "boolean")) throw new Error("Invalid text typography");
  const bold = value.bold ?? false, italic = value.italic ?? false;
  return { fontFamily: font.id, bold, italic,
    fontFile: `/usr/share/fonts/dejavu/${font.files[Number(bold) + 2 * Number(italic)]}`,
    style: { fontFamily: font.css, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" },
  };
}
