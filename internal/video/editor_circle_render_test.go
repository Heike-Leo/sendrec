package video

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCircleStrokeWidthContract(t *testing.T) {
	a := editorAnnotation{ID: "circle", Type: "circle", X: 10, Y: 10, Width: 30, Height: 20, End: 2}
	legacy := rasterCircle(a, 1920, 1080)
	for _, stroke := range []float64{1, 2, 3, 6, 9} {
		a.StrokeWidth = &stroke
		timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
		timeline.Annotations = []editorAnnotation{a}
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatal(err)
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
			t.Fatal("stroke roundtrip")
		}
		img := rasterCircle(a, 1920, 1080)
		if stroke == 3 && !bytes.Equal(img.Pix, legacy.Pix) {
			t.Fatal("legacy raster changed")
		}
		// At the top of the oval, integrate alpha across the contour normal.
		coverage := 0.
		for y := 0; y < img.Bounds().Dy()/2; y++ {
			coverage += float64(img.NRGBAAt(img.Bounds().Dx()/2, y).A) / 255
		}
		if math.Abs(coverage-stroke) > .15 {
			t.Fatalf("stroke %v coverage %v", stroke, coverage)
		}
		if img.NRGBAAt(img.Bounds().Dx()/2, img.Bounds().Dy()/2).A != 0 {
			t.Fatal("filled interior")
		}
	}
	for _, stroke := range []float64{0, -1, 4, 10, math.NaN(), math.Inf(1)} {
		a.StrokeWidth = &stroke
		timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 2, Duration: 2})
		timeline.Annotations = []editorAnnotation{a}
		if err := validateEditTimeline(&timeline); err == nil {
			t.Fatalf("accepted %v", stroke)
		}
	}
	// The thick contour is clipped at its unchanged box, never shifts or fills
	// the center, even for the minimum one-percent oval at the frame edge.
	stroke := 9.
	a = editorAnnotation{ID: "edge", Type: "circle", Width: 1, Height: 1, End: 2, StrokeWidth: &stroke}
	img := rasterCircle(a, 1920, 1080)
	if img.Bounds() != arrowBounds(a, 1920, 1080) {
		t.Fatal("box changed")
	}
	if img.NRGBAAt(img.Bounds().Dx()/2, img.Bounds().Dy()/2).A != 0 {
		t.Fatal("small oval filled")
	}
	if img.NRGBAAt(img.Bounds().Dx()/2, 0).A == 0 {
		t.Fatal("edge contour missing")
	}
}

func TestCircleStrokeWidthFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=1", "-c:v", "libx264", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	timeline := validTimeline(editClip{ID: "c", SourceID: "s", SourceEnd: 1, Duration: 1})
	for i, stroke := range []float64{1, 3, 9} {
		s := stroke
		timeline.Annotations = append(timeline.Annotations, editorAnnotation{ID: fmt.Sprint(i), Type: "circle", X: 5 + float64(i)*30, Y: 20, Width: 25, Height: 40, Start: .2, End: .8, Color: "#ffffff", StrokeWidth: &s})
	}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "widths.mp4")
	cmd := exec.Command("ffmpeg", buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, output, nil, timeline.Annotations)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for _, at := range []string{"0.1", "0.5", "0.9"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-").Output()
		if err != nil || len(pixels) != 1920*1080 {
			t.Fatal("decode", err)
		}
		for _, a := range timeline.Annotations {
			x, cy := int((a.X+a.Width/2)*19.2), int((a.Y+a.Height/2)*10.8)
			top := int((a.Y + .03*a.Height) * 10.8)
			coverage := 0.
			for y := top - 10; y <= top+10; y++ {
				coverage += float64(pixels[y*1920+x]) / 255
			}
			want := 0.
			if at == "0.5" {
				want = *a.StrokeWidth
			}
			if math.Abs(coverage-want) > .25 {
				t.Fatalf("time %s stroke %v coverage %v", at, *a.StrokeWidth, coverage)
			}
			if pixels[cy*1920+x] > 25 {
				t.Fatal("encoded interior filled")
			}
		}
	}
}

func TestCircleCanonicalPreviewContract(t *testing.T) {
	a := editorAnnotation{ID: "unchanged-circle", Type: "circle", X: 10, Y: 20, Width: 30, Height: 20, Start: .2, End: 5.8}
	if arrowBounds(a, 1920, 1080) != image.Rect(192, 216, 768, 432) {
		t.Fatal("render box changed")
	}
	img := rasterCircle(a, 1920, 1080)
	if img.NRGBAAt(288, 108).A != 0 {
		t.Fatal("ring interior filled")
	}
	for _, c := range []struct {
		name       string
		x, y, w, h float64
	}{
		{"16:9", 0, 0, 1920, 1080}, {"4:3", 0, 0, 1920, 1080},
		{"9:16", 0, 0, 1920, 1080}, {"12:5", 0, 0, 1920, 1080},
	} {
		t.Run(c.name, func(t *testing.T) {
			cx, cy := c.x+c.w*.25, c.y+c.h*.3
			w, h := c.w*.3, c.h*.2
			if cx != 480 || cy != 324 || w != 576 || h != 216 {
				t.Fatal("canonical box mismatch")
			}
			t.Logf("center %.3f,%.3f; full SVG content %.3fx%.3f; ring centerline diameters %.3fx%.3f", cx, cy, w, h, .94*w, .94*h)
		})
	}
}

func TestCircleRasterGeometryAndColor(t *testing.T) {
	for _, size := range [][2]int{{1000, 1000}, {1920, 1080}, {640, 360}} {
		for _, hex := range []string{"", "#12ab34"} {
			a := editorAnnotation{Type: "circle", X: 10, Y: 20, Width: 30, Height: 20, Color: hex}
			bounds := arrowBounds(a, size[0], size[1])
			img := rasterCircle(a, size[0], size[1])
			if img.Bounds() != image.Rect(0, 0, bounds.Dx(), bounds.Dy()) {
				t.Fatal("wrong scaled bounds")
			}
			cx, cy := bounds.Dx()/2, bounds.Dy()/2
			if img.NRGBAAt(cx, cy).A != 0 || img.NRGBAAt(0, 0).A != 0 {
				t.Fatal("circle must not be filled")
			}
			want := color.NRGBA{252, 38, 103, 255}
			if hex != "" {
				want = color.NRGBA{18, 171, 52, 255}
			}
			count := 0
			for x := 0; x < bounds.Dx(); x++ {
				pixel := img.NRGBAAt(x, cy)
				if pixel.A > 0 && (pixel.R != want.R || pixel.G != want.G || pixel.B != want.B) {
					t.Fatal("incorrect ring color")
				}
				if x > cx && pixel.A > 127 {
					count++
				}
			}
			if count < 2 || count > 4 {
				t.Fatalf("stroke not about 3 pixels at %v: %d", size, count)
			}
		}
	}
	// Equal pixel dimensions create a circular outline, without rotation.
	a := editorAnnotation{Type: "circle", Width: 100, Height: 100}
	img := rasterCircle(a, 100, 100)
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			if img.NRGBAAt(x, y).A != img.NRGBAAt(y, x).A {
				t.Fatal("circle not symmetric")
			}
		}
	}
	a.Rotation = 37
	other := rasterCircle(a, 100, 100)
	if string(img.Pix) != string(other.Pix) {
		t.Fatal("circle rotation must be ignored")
	}
}

func TestCircleRenderOrderAndBounds(t *testing.T) {
	annotations := []editorAnnotation{
		{Type: "circle", ID: "c", X: 70, Y: 60, Width: 30, Height: 40, Start: .25, End: 1.75},
		{Type: "arrow", ID: "a", Width: 20, Height: 20, End: 2},
	}
	args := buildAnnotatedTimelineRenderArgs([]string{"input.mp4"}, []editClip{{SourceID: "s", SourceEnd: 2, Duration: 2}}, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, "out.mp4", nil, annotations)
	joined := strings.Join(args, " ")
	if strings.Index(joined, "arrow-0.png") > strings.Index(joined, "circle-1.png") || !strings.Contains(joined, "[varrow0rgb][2:v]overlay=x=1344:y=648") || !strings.Contains(joined, "between(t,0.250000,1.750000)") {
		t.Fatal(joined)
	}
	img := rasterCircle(annotations[0], 1920, 1080)
	if img.Bounds().Dx() != 576 || img.Bounds().Dy() != 432 {
		t.Fatal("incorrect edge geometry")
	}
}

func TestTimelineCircleRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	arrow := editorAnnotation{ID: "arrow", Type: "arrow", Width: 100, Height: 100, End: 2, Color: "#ffff00"}
	circles := []editorAnnotation{
		{ID: "green", Type: "circle", X: 10, Y: 35, Width: 20, Height: 30, Start: .5, End: 1.5, Color: "#00ff00"},
		{ID: "pink", Type: "circle", X: 50, Y: 5, Width: 15, Height: 80. / 3, Start: .5, End: 1.5},
		{ID: "blue", Type: "circle", X: 70, Y: 60, Width: 30, Height: 40, Start: .75, End: 1.25, Color: "#0088ff"},
	}
	timeline := validTimeline(editClip{ID: "clip", SourceID: "s", SourceEnd: 2, Duration: 2})
	timeline.Overlays = []editorCoverOverlay{{ID: "blur", Mode: "blur", Width: 100, Height: 100, End: 2}, {ID: "cover", Width: 100, Height: 100, End: 2}}
	timeline.Annotations = append(append([]editorAnnotation{}, circles...), arrow)
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	render := func(name string, annotations []editorAnnotation) string {
		output := filepath.Join(dir, name)
		cmd := exec.Command("ffmpeg", buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"s": 0}, map[string]sourceVideo{"s": {}}, output, timeline.Overlays, annotations)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("render: %v %s", err, out)
		}
		return output
	}
	actual := render("rings.mp4", timeline.Annotations)
	reference := render("arrows-only.mp4", []editorAnnotation{arrow})
	decode := func(path, at string) []byte {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("decode: %v", err)
		}
		return pixels
	}
	colors := [][3]int{{0, 255, 0}, {252, 38, 103}, {0, 136, 255}}
	for _, at := range []string{"0.25", "0.6", "1.0", "1.4", "1.75"} {
		pixels, base := decode(actual, at), decode(reference, at)
		for i, a := range circles {
			active := at != "0.25" && at != "1.75" && (i != 2 || at == "1.0")
			cx, cy := (a.X+a.Width/2)*19.2, (a.Y+a.Height/2)*10.8
			rx, ry := a.Width*19.2*.47, a.Height*10.8*.47
			for _, angle := range []float64{0, math.Pi / 2, math.Pi, 3 * math.Pi / 2} {
				x, y := int(cx+rx*math.Cos(angle)), int(cy+ry*math.Sin(angle))
				found := false
				for dy := -2; dy <= 2; dy++ {
					for dx := -2; dx <= 2; dx++ {
						p := ((y+dy)*1920 + x + dx) * 3
						match := true
						for c := 0; c < 3; c++ {
							want := colors[i][c]
							if !active {
								want = int(base[p+c])
							}
							if math.Abs(float64(int(pixels[p+c])-want)) > 65 {
								match = false
							}
						}
						found = found || match
					}
				}
				if !found {
					t.Fatal(fmt.Sprintf("circle %d at %s missing/incorrect contour near %d,%d", i, at, x, y))
				}
			}
			// Transparent center must retain the underlying arrow/video.
			p := (int(cy)*1920 + int(cx)) * 3
			for c := 0; c < 3; c++ {
				if math.Abs(float64(int(pixels[p+c])-int(base[p+c]))) > 25 {
					t.Fatal("filled circle interior")
				}
			}
		}
		// When all rings are inactive, the full frame must match legacy output.
		if at == "0.25" || at == "1.75" {
			for p := 0; p < len(pixels); p += 3 {
				for c := 0; c < 3; c++ {
					if math.Abs(float64(int(pixels[p+c])-int(base[p+c]))) > 45 {
						t.Fatal("ring visible outside time window")
					}
				}
			}
		}
	}
}
