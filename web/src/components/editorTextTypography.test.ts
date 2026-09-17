import { describe, expect, it } from "vitest";
import { TEXT_FONTS, textTypography } from "./editorTextTypography";
import { validateTextAnnotation } from "./editorAnnotations";

describe("controlled text typography", () => {
  it("defaults without mutating legacy data", () => {
    const legacy = {};
    expect(textTypography(legacy)).toMatchObject({ fontFamily: "dejavu-sans", bold: false, italic: false });
    expect(legacy).toEqual({});
  });
  for (const font of TEXT_FONTS) for (const bold of [false, true]) for (const italic of [false, true]) {
    it(`${font.id} bold=${bold} italic=${italic} maps and roundtrips`, () => {
      const value = { id: "t", type: "text", text: "äöü\nß", x: 0, y: 0, width: 40, height: 10, start: 0, end: 5, fontSize: 32, fontFamily: font.id, bold, italic };
      expect(() => validateTextAnnotation(value)).not.toThrow();
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
      expect(textTypography(value).fontFile).toBe(`/usr/share/fonts/dejavu/${font.files[Number(bold) + 2 * Number(italic)]}`);
    });
  }
  it.each([{ fontFamily: "Arial" }, { fontFamily: "" }, { fontFamily: null }, { bold: "true" }, { bold: null }, { italic: 1 }])("rejects invalid fields %j", patch => {
    expect(() => validateTextAnnotation({ id: "t", type: "text", text: "Text", x: 0, y: 0, width: 40, height: 10, start: 0, end: 5, fontSize: 32, ...patch })).toThrow();
  });
});
