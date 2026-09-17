package video

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTextRenderFontsAndLayout(t *testing.T) {
	for _, family := range []string{"dejavu-sans", "dejavu-serif", "dejavu-mono"} {
		base := map[string]string{"dejavu-sans": "DejaVuSans", "dejavu-serif": "DejaVuSerif", "dejavu-mono": "DejaVuSansMono"}[family]
		seen := map[string]bool{}
		for _, bold := range []bool{false, true} {
			for _, italic := range []bool{false, true} {
				a := textTestTimeline().Annotations[0]
				a.FontFamily, a.Bold, a.Italic = &family, &bold, &italic
				font := textAnnotationFont(a)
				suffix := ""
				if bold {
					suffix = "Bold"
				}
				if italic {
					if family == "dejavu-serif" {
						suffix += "Italic"
					} else {
						suffix += "Oblique"
					}
				}
				if suffix != "" {
					suffix = "-" + suffix
				}
				if font != "/usr/share/fonts/dejavu/"+base+suffix+".ttf" {
					t.Fatal(font)
				}
				if seen[font] || !strings.HasSuffix(font, ".ttf") {
					t.Fatal(font)
				}
				seen[font] = true
				graph := textAnnotationLayer(0, a)
				for _, want := range []string{font, "s=768x108", "fontsize=32.000000", "fontcolor=#Ab12Cd", "expansion=none", "y='38.400000+", "y='76.800000+", "font_a-font_d", "x=0"} {
					if !strings.Contains(graph, want) {
						t.Fatalf("missing %s: %s", want, graph)
					}
				}
				if strings.Contains(graph, a.Text) {
					t.Fatal("user text in graph")
				}
			}
		}
	}
	a := textTestTimeline().Annotations[0]
	a.Color = ""
	if !strings.Contains(textAnnotationLayer(0, a), "fontcolor=#FFFFFF") || !strings.HasSuffix(textAnnotationFont(a), "/DejaVuSans.ttf") {
		t.Fatal("legacy defaults")
	}
}

func TestTextRenderSidecarsAndOrder(t *testing.T) {
	timeline := textTestTimeline()
	a := timeline.Annotations[0]
	a.Text = "Grüße äöü ÄÖÜ ß: '%{n}'\\\n\nZeile 3"
	timeline.Annotations = []editorAnnotation{a, {ID: "arrow", Type: "arrow", Width: 20, Height: 20, End: 3}}
	dir := t.TempDir()
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	for i, want := range strings.Split(a.Text, "\n") {
		got, err := os.ReadFile(filepath.Join(dir, textAnnotationFilename(1, i)))
		if err != nil || string(got) != want {
			t.Fatalf("line %d: %q %v", i, got, err)
		}
	}
	args := func(annotations []editorAnnotation) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"in.mp4"}, timeline.Clips, map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, "out.mp4", nil, annotations)
	}
	graph := strings.Join(args(timeline.Annotations), " ")
	for _, want := range []string{"arrow-0.png", "[varrow0rgb][textannotation1]overlay=x=192:y=216", "between(t,1.000000,4.000000)"} {
		if !strings.Contains(graph, want) {
			t.Fatal(graph)
		}
	}
	base := buildTimelineRenderArgs([]string{"in.mp4"}, timeline.Clips, map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, "out.mp4")
	if !reflect.DeepEqual(args(nil), base) {
		t.Fatal("no-text pipeline changed")
	}
}

func TestTimelineTextRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	font := textAnnotationFont(editorAnnotation{})
	if local := os.Getenv("SENDREC_TEST_DEJAVU_FONT"); local != "" {
		font = local
	}
	if _, err := os.Stat(font); err != nil {
		t.Skip("DejaVu Sans not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=30", "-c:v", "libx264", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	timeline := validTimeline(editClip{ID: "clip", SourceID: "s", SourceEnd: 2, Duration: 2})
	// Long lines and surplus manual lines must be clipped, never wrapped.
	a := editorAnnotation{ID: "text", Type: "text", Text: "Grüße äöü ÄÖÜ ß lange Zeile\nGrüße\n\nAbgeschnitten", X: 10, Y: 20, Width: 20, Height: 10, FontSize: 48, Start: .5, End: 1.5, Color: "#00ff00"}
	timeline.Annotations = []editorAnnotation{a}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "text.mp4")
	args := buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, output, nil, timeline.Annotations)
	for i := range args {
		args[i] = strings.ReplaceAll(args[i], textAnnotationFont(a), font)
	}
	cmd := exec.Command("ffmpeg", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render: %v %s", err, out)
	}
	for _, at := range []string{"0.25", "1.0", "1.75"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("decode %s: %v", at, err)
		}
		rows := make([]int, 1080)
		// Empty space inside the text box must retain the source, not paint a
		// black background (also verifies the RGBA layer's actual alpha).
		p := (320*1920 + 570) * 3
		if pixels[p+2] < 180 || pixels[p] > 40 || pixels[p+1] > 40 {
			t.Fatal("text box is not transparent")
		}
		for y := 0; y < 1080; y++ {
			for x := 0; x < 1920; x++ {
				p := (y*1920 + x) * 3
				if pixels[p+1] > 100 && int(pixels[p+1]) > int(pixels[p])+70 {
					if at != "1.0" || x < 190 || x > 577 || y < 214 || y > 325 {
						t.Fatalf("text outside time/box: %s %d,%d", at, x, y)
					}
					rows[y]++
				}
			}
		}
		if at == "1.0" {
			for _, interval := range [][2]int{{220, 268}, {278, 324}} {
				count := 0
				for y := interval[0]; y < interval[1]; y++ {
					count += rows[y]
				}
				if count < 100 {
					t.Fatal(fmt.Sprintf("missing manual line at %v", interval))
				}
			}
		}
	}
}
