package video

import (
	"fmt"
	"image"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var testSymbolIDs = []string{"check", "cross", "warning", "info", "star", "pointer", "plus", "question"}

// Counterpart of the canonical DOM regression: source aspect ratio never enters symbol
// rasterization; the output box and the rotated plus arm remain canonical.
func TestSymbolCanonicalDiagnosticContract(t *testing.T) {
	a := editorAnnotation{ID: "aspect-symbol", Type: "symbol", Symbol: "plus", X: 10, Y: 20, Width: 30, Height: 20, Rotation: 37, Start: .2, End: 5.8, Color: "#00ff00"}
	bounds := arrowBounds(a, 1920, 1080)
	if bounds != image.Rect(192, 216, 768, 432) {
		t.Fatal("canonical bounds changed", bounds)
	}
	img := rasterSymbol(a, 1920, 1080)
	r := 37 * math.Pi / 180
	// Horizontal plus arm is (3,8)..(13,8), becoming (30,50)..(70,50).
	for _, offset := range []float64{-15, 0, 15} {
		x := int((50 + offset*math.Cos(r)) * 5.76)
		y := int((50 + offset*math.Sin(r)) * 2.16)
		if p := img.NRGBAAt(x, y); p.A == 0 || p.G != 255 {
			t.Fatalf("missing rotated arm at %d,%d: %v", x, y, p)
		}
	}
	angle := math.Atan2(216*math.Sin(r), 576*math.Cos(r)) * 180 / math.Pi
	t.Logf("all sources: box 192,216 576x216; center 480,324; rotated plus arm angle %.9f degrees", angle)
	clips := []editClip{{ID: "one", SourceID: "wide", SourceEnd: 3, Duration: 3}, {ID: "two", SourceID: "portrait", SourceEnd: 3, Duration: 3}}
	args := strings.Join(buildAnnotatedTimelineRenderArgs([]string{"wide.mp4", "portrait.mp4"}, clips, map[string]int{"wide": 0, "portrait": 1}, map[string]sourceVideo{"wide": {}, "portrait": {}}, "out.mp4", nil, []editorAnnotation{a}), " ")
	for _, want := range []string{"overlay=x=192:y=216", "between(t,0.200000,5.800000)"} {
		if !strings.Contains(args, want) {
			t.Fatalf("missing %s: %s", want, args)
		}
	}
}

func TestSymbolRasterGeometry(t *testing.T) {
	// Independent SVG landmarks: one point on each stroke and a transparent
	// point. These catch missing shapes or accidental backgrounds.
	marks := [][2]arrowPoint{
		{{6, 11}, {8, 3}}, {{3, 3}, {8, 3}}, {{8, 2}, {6, 10}}, {{8, 2}, {5, 8}},
		{{8, 2}, {8, 8}}, {{6, 3}, {10, 10}}, {{8, 8}, {3, 3}}, {{8, 2}, {4, 8}},
	}
	for i, id := range testSymbolIDs {
		g := symbolShape(id)
		if !g.contains(marks[i][0]) || g.contains(marks[i][1]) {
			t.Fatalf("SVG landmarks differ for %s", id)
		}
		for _, size := range [][2]int{{320, 180}, {640, 360}} {
			for _, angle := range []float64{0, 37, 90, 225} {
				a := editorAnnotation{Type: "symbol", Symbol: id, X: 70, Y: 60, Width: 30, Height: 40, Rotation: angle}
				img := rasterSymbol(a, size[0], size[1])
				bounds := arrowBounds(a, size[0], size[1])
				if img.Bounds() != image.Rect(0, 0, bounds.Dx(), bounds.Dy()) {
					t.Fatal("incorrect scaled bounds")
				}
				visible := 0
				for y := 0; y < img.Bounds().Dy(); y++ {
					for x := 0; x < img.Bounds().Dx(); x++ {
						p := img.NRGBAAt(x, y)
						if p.A > 0 {
							visible++
							if p.R != 252 || p.G != 38 || p.B != 103 {
								t.Fatal("incorrect fallback color")
							}
							if x == 0 || y == 0 || x == img.Bounds().Dx()-1 || y == img.Bounds().Dy()-1 {
								t.Fatal("symbol touches frame edge")
							}
						}
					}
				}
				if visible == 0 {
					t.Fatalf("empty %s at %v", id, angle)
				}
			}
		}
	}
	// Rotated cross endpoints independently locate the transformed SVG stroke.
	a := editorAnnotation{Symbol: "cross", Width: 100, Height: 100, Rotation: 37, Color: "#12ab34"}
	img := rasterSymbol(a, 400, 200)
	r := 37 * math.Pi / 180
	x, y := int((50-20*math.Cos(r)+20*math.Sin(r))*4), int((50-20*math.Sin(r)-20*math.Cos(r))*2)
	p := img.NRGBAAt(x, y)
	if p.A != 255 || p.R != 18 || p.G != 171 || p.B != 52 {
		t.Fatalf("rotation/color wrong at %d,%d: %v", x, y, p)
	}
}

func TestSymbolRenderOrderAndValidation(t *testing.T) {
	timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
	symbol := editorAnnotation{ID: "symbol", Type: "symbol", Symbol: "check", X: 70, Y: 60, Width: 30, Height: 40, Start: .5, End: 1.5}
	arrow := editorAnnotation{ID: "arrow", Type: "arrow", Width: 20, Height: 20, End: 2}
	circle := editorAnnotation{ID: "circle", Type: "circle", Width: 20, Height: 20, End: 2}
	args := func(a []editorAnnotation) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"input.mp4"}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "out.mp4", nil, a)
	}
	legacy := buildTimelineRenderArgs([]string{"input.mp4"}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "out.mp4", nil, nil)
	if !reflect.DeepEqual(args(nil), legacy) {
		t.Fatal("empty annotations changed")
	}
	if !reflect.DeepEqual(exportAnnotations([]editorAnnotation{symbol, circle, arrow}), []editorAnnotation{arrow, circle, symbol}) {
		t.Fatal("wrong layer order")
	}
	joined := strings.Join(args([]editorAnnotation{symbol, circle, arrow}), " ")
	for _, part := range []string{"arrow-0.png", "circle-1.png", "symbol-2.png", "[varrow1rgb][3:v]overlay=x=1344:y=648", "between(t,0.500000,1.500000)"} {
		if !strings.Contains(joined, part) {
			t.Fatalf("missing %s: %s", part, joined)
		}
	}
	timeline.Annotations = []editorAnnotation{symbol}
	timeline.Annotations[0].Symbol = "bad;movie=x"
	if err := prepareArrowFiles(t.TempDir(), timeline); err == nil {
		t.Fatal("invalid symbol accepted")
	}
}

func TestTimelineSymbolRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
	colors := []string{"", "#00ff00", "#0088ff", "#ff8800", "#ffff00", "#ffffff", "#ff00ff", "#00ffff"}
	for i, id := range testSymbolIDs {
		timeline.Annotations = append(timeline.Annotations, editorAnnotation{ID: fmt.Sprint(i), Type: "symbol", Symbol: id, X: float64(i%4) * 25, Y: float64(i/4) * 50, Width: 25, Height: 50, Start: .5 + float64(i%2)*.25, End: 1.5 - float64(i%2)*.25, Rotation: []float64{0, 37, 90, 225}[i%4], Color: colors[i]})
	}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "symbols.mp4")
	cmd := exec.Command("ffmpeg", buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, output, nil, timeline.Annotations)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render: %v %s", err, out)
	}
	rasters := make([]*image.NRGBA, len(timeline.Annotations))
	for i, a := range timeline.Annotations {
		rasters[i] = rasterSymbol(a, 1920, 1080)
	}
	for _, at := range []string{"0.25", "0.6", "1.0", "1.4", "1.75"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("decode: %v", err)
		}
		for i, a := range timeline.Annotations {
			img := rasters[i]
			bounds := arrowBounds(a, 1920, 1080)
			checked := 0
			for y := 2; y < img.Bounds().Dy()-2; y += 7 {
				for x := 2; x < img.Bounds().Dx()-2; x += 7 {
					p := img.NRGBAAt(x, y)
					if p.A != 255 || img.NRGBAAt(x-2, y).A != 255 || img.NRGBAAt(x+2, y).A != 255 {
						continue
					}
					interior := true
					for dy := -3; dy <= 3; dy++ {
						for dx := -3; dx <= 3; dx++ {
							if img.NRGBAAt(x+dx, y+dy).A != 255 {
								interior = false
							}
						}
					}
					if !interior {
						continue
					}
					want := []uint8{p.R, p.G, p.B}
					if !(at == "1.0" || (i%2 == 0 && (at == "0.6" || at == "1.4"))) {
						want = []uint8{0, 0, 0}
					}
					offset := ((bounds.Min.Y+y)*1920 + bounds.Min.X + x) * 3
					for c := 0; c < 3; c++ {
						if math.Abs(float64(int(pixels[offset+c])-int(want[c]))) > 65 {
							t.Fatalf("%s at %s wrong pixel at %d,%d: got %v want %v", a.Symbol, at, x, y, pixels[offset:offset+3], want)
						}
					}
					checked++
				}
			}
			if checked < 5 {
				t.Fatalf("insufficient visible samples for %s", a.Symbol)
			}
		}
	}
}
