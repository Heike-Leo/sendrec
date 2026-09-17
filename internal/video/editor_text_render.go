package video

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Same controlled families/styles as editorTextTypography.ts; never interpolate
// a user supplied font path into the graph.
func textAnnotationFont(a editorAnnotation) string {
	family := "dejavu-sans"
	if a.FontFamily != nil {
		family = *a.FontFamily
	}
	fonts := map[string][4]string{
		"dejavu-sans":  {"DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"},
		"dejavu-serif": {"DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-BoldItalic.ttf"},
		"dejavu-mono":  {"DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf", "DejaVuSansMono-Oblique.ttf", "DejaVuSansMono-BoldOblique.ttf"},
	}
	i := 0
	if a.Bold != nil && *a.Bold {
		i++
	}
	if a.Italic != nil && *a.Italic {
		i += 2
	}
	return "/usr/share/fonts/dejavu/" + fonts[family][i]
}

func textAnnotationFilename(index, line int) string {
	return fmt.Sprintf("annotation-text-%d-%d.txt", index, line)
}

func prepareTextAnnotationFiles(dir string, index int, a editorAnnotation) error {
	for line, value := range strings.Split(a.Text, "\n") {
		if err := os.WriteFile(filepath.Join(dir, textAnnotationFilename(index, line)), []byte(value), 0600); err != nil {
			return fmt.Errorf("prepare text annotation: %w", err)
		}
	}
	return nil
}

// A box-sized RGBA surface clips both axes, with no automatic wrapping or
// box growth. Each manual line has the preview's fixed 1.2em line height.
// Font metrics, not the particular glyphs on a line, determine its baseline.
func textAnnotationLayer(index int, a editorAnnotation) string {
	bounds := arrowBounds(a, editorRenderWidth, editorRenderHeight)
	hex := a.Color
	if hex == "" {
		hex = "#FFFFFF"
	}
	graph := fmt.Sprintf("color=c=black@0.0:s=%dx%d:r=30,format=rgba", bounds.Dx(), bounds.Dy())
	for line, value := range strings.Split(a.Text, "\n") {
		if value == "" {
			continue
		}
		graph += fmt.Sprintf(",drawtext=fontfile=%s:textfile=%s:expansion=none:fontcolor=%s:fontsize=%.6f:x=0:y='%.6f+(%.6f-font_a-font_d)/2+font_a-ascent'",
			textAnnotationFont(a), textAnnotationFilename(index, line), hex, a.FontSize, float64(line)*a.FontSize*1.2, a.FontSize*1.2)
	}
	return graph + fmt.Sprintf("[textannotation%d]", index)
}
