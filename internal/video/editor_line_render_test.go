package video

import (
	"encoding/json"
	"image"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Same saved line as the DOM contract. The preview's canonical frame scales
// uniformly to output pixels, regardless of the source's contained rectangle.
func TestLineAspectRatioRenderContract(t *testing.T) {
	a := editorAnnotation{ID: "aspect-line", Type: "line", X: 10, Y: 20, Width: 30, Height: 20, Rotation: 37, Start: .2, End: 5.8}
	p, q := lineEndpoints(a, 1920, 1080)
	for _, tc := range []struct {
		name       string
		x, y, w, h float64
	}{
		{"16:9", 0, 0, 1920, 1080}, {"4:3", 0, 0, 1920, 1080},
		{"9:16", 0, 0, 1920, 1080}, {"12:5", 0, 0, 1920, 1080},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pp := arrowPoint{tc.x + p.x*tc.w/1920, tc.y + p.y*tc.h/1080}
			pq := arrowPoint{tc.x + q.x*tc.w/1920, tc.y + q.y*tc.h/1080}
			length := math.Hypot(q.x-p.x, q.y-p.y)
			previewLength := math.Hypot(pq.x-pp.x, pq.y-pp.y)
			angle := math.Atan2(q.y-p.y, q.x-p.x) * 180 / math.Pi
			previewAngle := math.Atan2(pq.y-pp.y, pq.x-pp.x) * 180 / math.Pi
			centerDX, centerDY := (pp.x+pq.x-p.x-q.x)/2, (pp.y+pq.y-p.y-q.y)/2
			if math.Hypot(pp.x-p.x, pp.y-p.y) > 1e-9 || math.Hypot(pq.x-q.x, pq.y-q.y) > 1e-9 || math.Abs(previewLength-length) > 1e-9 || math.Abs(previewAngle-angle) > 1e-9 {
				t.Fatal("canonical preview differs from unchanged render")
			}
			t.Logf("center delta=(%.3f,%.3f) px; length preview/render=%.3f/%.3f px; angle preview/render=%.3f/%.3f deg; endpoints preview=(%.3f,%.3f)-(%.3f,%.3f), render=(%.3f,%.3f)-(%.3f,%.3f)", centerDX, centerDY, previewLength, length, previewAngle, angle, pp.x, pp.y, pq.x, pq.y, p.x, p.y, q.x, q.y)
		})
	}
}

func TestLineEndpointBoundsPersistAtFrameEdge(t *testing.T) {
	for _, angle := range []float64{0, 180, 90, 270, 45, 37, 217} {
		sin, cos := math.Sincos(angle * math.Pi / 180)
		ax, ay := 1., 1.
		if cos < 0 {
			ax = 99
		}
		if sin < 0 {
			ay = 99
		}
		limit := func(origin, delta float64) float64 {
			if math.Abs(delta) < 1e-10 {
				return math.Inf(1)
			}
			if delta > 0 {
				return (100 - origin) / delta
			}
			return -origin / delta
		}
		size := math.Min(limit(ax, .84*cos), limit(ay, .84*sin))
		a := editorAnnotation{ID: "edge", Type: "line", X: ax - size*(.5-.42*cos), Y: ay - size*(.5-.42*sin), Width: size, Height: size, Rotation: angle, End: 2}
		timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
		timeline.Annotations = []editorAnnotation{a}
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatalf("angle %v: %v", angle, err)
		}
		data, err := json.Marshal(timeline)
		if err != nil {
			t.Fatal(err)
		}
		var restored editTimeline
		if err := json.Unmarshal(data, &restored); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(restored.Annotations[0], a) {
			t.Fatal("geometry changed on reload")
		}
		p, q := lineEndpoints(a, 100, 100)
		if math.Abs(p.x-ax) > 1e-8 || math.Abs(p.y-ay) > 1e-8 {
			t.Fatal("fixed endpoint moved")
		}
		if math.Min(math.Min(math.Abs(q.x), math.Abs(100-q.x)), math.Min(math.Abs(q.y), math.Abs(100-q.y))) > 1e-8 {
			t.Fatal("endpoint did not reach edge")
		}
		// Existing renderer accepts the same extended viewport without any changes.
		if err := prepareArrowFiles(t.TempDir(), restored); err != nil {
			t.Fatal(err)
		}
		timeline.Annotations[0].X += cos
		timeline.Annotations[0].Y += sin
		if err := validateEditTimeline(&timeline); err == nil {
			t.Fatal("outside endpoint accepted")
		}
	}
}

func TestLineRasterGeometryAndColor(t *testing.T) {
	for _, size := range [][2]int{{1920, 1080}, {640, 480}} {
		for _, angle := range []float64{0, 23, 90, 217} {
			for _, w := range []float64{15, 30} {
				a := editorAnnotation{Type: "line", X: 70, Y: 60, Width: w, Height: 40, Rotation: angle}
				p, q := lineEndpoints(a, size[0], size[1])
				radians := angle * math.Pi / 180
				wantX := (a.X + a.Width/2 + .42*a.Width*math.Cos(radians)) * float64(size[0]) / 100
				wantY := (a.Y + a.Height/2 + .42*a.Height*math.Sin(radians)) * float64(size[1]) / 100
				if math.Abs(q.x-wantX) > 1e-8 || math.Abs(q.y-wantY) > 1e-8 {
					t.Fatal("rotation/scaling differs from SVG")
				}
				wantLength := .84 * math.Hypot(a.Width*float64(size[0])/100*math.Cos(radians), a.Height*float64(size[1])/100*math.Sin(radians))
				if math.Abs(math.Hypot(q.x-p.x, q.y-p.y)-wantLength) > 1e-8 {
					t.Fatal("wrong length")
				}
				bounds := arrowBounds(a, size[0], size[1])
				img := rasterLine(a, size[0], size[1])
				if img.Bounds() != image.Rect(0, 0, bounds.Dx(), bounds.Dy()) {
					t.Fatal("wrong PNG bounds")
				}
				count := 0
				for y := 0; y < img.Bounds().Dy(); y++ {
					for x := 0; x < img.Bounds().Dx(); x++ {
						pixel := img.NRGBAAt(x, y)
						if pixel.A > 0 {
							count++
							if pixel.R != 252 || pixel.G != 38 || pixel.B != 103 {
								t.Fatal("wrong default color")
							}
							if x == 0 || y == 0 || x == img.Bounds().Dx()-1 || y == img.Bounds().Dy()-1 {
								t.Fatal("stroke escapes bounds")
							}
						}
					}
				}
				if count == 0 {
					t.Fatal("empty line")
				}
			}
		}
	}
	// Width/height scaling must not change the three-pixel stroke.
	for _, size := range []int{100, 400} {
		img := rasterLine(editorAnnotation{Width: 100, Height: 100, Color: "#123abc"}, size, size)
		coverage := 0.
		for y := 0; y < size; y++ {
			p := img.NRGBAAt(size/2, y)
			coverage += float64(p.A) / 255
			if p.A > 0 && (p.R != 18 || p.G != 58 || p.B != 188) {
				t.Fatal("custom color lost")
			}
		}
		if math.Abs(coverage-3) > .02 {
			t.Fatalf("stroke thickness %v", coverage)
		}
	}
}

func TestLineRenderOrderAndBounds(t *testing.T) {
	timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
	line := editorAnnotation{ID: "line", Type: "line", X: 70, Y: 60, Width: 30, Height: 40, Start: .5, End: 1.5}
	others := []editorAnnotation{{ID: "a", Type: "arrow", Width: 20, Height: 20, End: 2}, {ID: "c", Type: "circle", Width: 20, Height: 20, End: 2}, {ID: "s", Type: "symbol", Symbol: "plus", Width: 20, Height: 20, End: 2}}
	mixed := append([]editorAnnotation{line}, others...)
	if !reflect.DeepEqual(exportAnnotations(mixed), append(append([]editorAnnotation{}, others...), line)) {
		t.Fatal("line not last")
	}
	args := func(a []editorAnnotation) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"input.mp4"}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "out.mp4", nil, a)
	}
	if !reflect.DeepEqual(args(nil), buildTimelineRenderArgs([]string{"input.mp4"}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "out.mp4", nil, nil)) {
		t.Fatal("legacy path changed")
	}
	joined := strings.Join(args(mixed), " ")
	for _, s := range []string{"line-3.png", "[varrow2rgb][4:v]overlay=x=1344:y=648", "between(t,0.500000,1.500000)"} {
		if !strings.Contains(joined, s) {
			t.Fatal(joined)
		}
	}
	timeline.Annotations = mixed
	if err := prepareArrowFiles(t.TempDir(), timeline); err != nil {
		t.Fatal(err)
	}
	timeline.Annotations[0].X = 99
	if err := prepareArrowFiles(t.TempDir(), timeline); err == nil {
		t.Fatal("invalid geometry accepted")
	}
}

func TestTimelineLineRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
	timeline.Annotations = []editorAnnotation{
		{ID: "horizontal", Type: "line", X: 5, Y: 5, Width: 30, Height: 30, Start: .5, End: 1.5},
		{ID: "free", Type: "line", X: 50, Y: 5, Width: 40, Height: 30, Start: .75, End: 1.25, Rotation: 23, Color: "#00ff00"},
		{ID: "vertical", Type: "line", X: 5, Y: 55, Width: 20, Height: 40, Start: .5, End: 1.5, Rotation: 90, Color: "#0088ff"},
		{ID: "reverse", Type: "line", X: 50, Y: 55, Width: 45, Height: 35, Start: .75, End: 1.25, Rotation: 217, Color: "#ffff00"},
	}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "lines.mp4")
	cmd := exec.Command("ffmpeg", buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "lines.mp4", nil, timeline.Annotations)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render: %v %s", err, out)
	}
	colors := [][3]int{{252, 38, 103}, {0, 255, 0}, {0, 136, 255}, {255, 255, 0}}
	for _, at := range []string{"0.25", "0.6", "1.0", "1.4", "1.75"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("decode: %v", err)
		}
		for i, a := range timeline.Annotations {
			active := at == "1.0" || (i%2 == 0 && (at == "0.6" || at == "1.4"))
			p, q := lineEndpoints(a, 1920, 1080)
			for _, fraction := range []float64{.1, .5, .9} {
				x, y := int(p.x+(q.x-p.x)*fraction), int(p.y+(q.y-p.y)*fraction)
				found := false
				for dy := -2; dy <= 2; dy++ {
					for dx := -2; dx <= 2; dx++ {
						off := ((y+dy)*1920 + x + dx) * 3
						match := true
						for c := 0; c < 3; c++ {
							want := 0
							if active {
								want = colors[i][c]
							}
							if math.Abs(float64(int(pixels[off+c])-want)) > 75 {
								match = false
							}
						}
						found = found || match
					}
				}
				if !found {
					t.Fatalf("%s at %s not rendered at expected position/color", a.ID, at)
				}
			}
		}
		if at == "0.25" || at == "1.75" {
			for _, v := range pixels {
				if v > 25 {
					t.Fatal("line visible outside time window")
				}
			}
		}
	}
}
