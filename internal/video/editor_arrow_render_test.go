package video

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Render contract for the canonical DOM tests. No change to persisted arrow
// geometry or render positions is needed for any source aspect ratio.
func TestArrowAspectRatioRenderContract(t *testing.T) {
	a := editorAnnotation{ID: "aspect-arrow", Type: "arrow", X: 10, Y: 20, Width: 30, Height: 20, Rotation: 37, Start: .2, End: 5.8, Color: "#00ff00"}
	if got := arrowBounds(a, 1920, 1080); got != image.Rect(192, 216, 768, 432) {
		t.Fatal(got)
	}
	// Browser uses a 960x540 canonical canvas, independent of source metadata.
	preview, output := arrowVertices(a, 960, 540), arrowVertices(a, 1920, 1080)
	for i, p := range preview {
		if math.Abs(p.x*2-output[i].x) > 1e-9 || math.Abs(p.y*2-output[i].y) > 1e-9 {
			t.Fatal("canonical preview and render vertices disagree")
		}
	}
}

func TestArrowAspectRatioFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	formats := []struct{ name, filter string }{
		{"16:9", "color=c=blue:s=160x90:r=30:d=1"},
		{"4:3", "color=c=blue:s=160x120:r=30:d=1"},
		{"9:16", "color=c=blue:s=90x160:r=30:d=1"},
		{"12:5", "color=c=blue:s=240x100:r=30:d=1"},
		{"encoded-letterbox", "color=c=blue:s=160x90:r=30:d=1,drawbox=x=0:y=0:w=iw:h=15:c=black:t=fill,drawbox=x=0:y=75:w=iw:h=15:c=black:t=fill"},
		{"encoded-pillarbox", "color=c=blue:s=160x90:r=30:d=1,drawbox=x=0:y=0:w=20:h=ih:c=black:t=fill,drawbox=x=140:y=0:w=20:h=ih:c=black:t=fill"},
	}
	var inputs []string
	var clips []editClip
	indexes, sources := map[string]int{}, map[string]sourceVideo{}
	for i, format := range formats {
		input := filepath.Join(dir, fmt.Sprintf("source-%d.mp4", i))
		if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", strings.ReplaceAll(format.filter, "d=1", "d=6"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", format.name, err, out)
		}
		inputs = append(inputs, input)
		clips = append(clips, editClip{ID: format.name, SourceID: format.name, SourceEnd: 1, Duration: 1})
		indexes[format.name], sources[format.name] = i, sourceVideo{}
	}
	a := editorAnnotation{ID: "aspect-arrow", Type: "arrow", X: 10, Y: 20, Width: 30, Height: 20, Rotation: 37, Start: .2, End: 5.8, Color: "#00ff00"}
	timeline := validTimeline(clips...)
	timeline.Annotations = []editorAnnotation{a}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	bounds, mask := arrowBounds(a, 1920, 1080), rasterArrow(a, 1920, 1080)
	checkFrame := func(t *testing.T, output string, at float64) {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", fmt.Sprintf("%.3f", at), "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("decode %.1f: %v", at, err)
		}
		checked := 0
		for y := 3; y < bounds.Dy()-3; y += 3 {
			for x := 3; x < bounds.Dx()-3; x += 3 {
				if mask.NRGBAAt(x, y).A != 255 || mask.NRGBAAt(x-3, y).A != 255 || mask.NRGBAAt(x+3, y).A != 255 || mask.NRGBAAt(x, y-3).A != 255 || mask.NRGBAAt(x, y+3).A != 255 {
					continue
				}
				p := ((y+bounds.Min.Y)*1920 + x + bounds.Min.X) * 3
				green := pixels[p+1] > 180 && pixels[p] < 60 && pixels[p+2] < 60
				if green != (at >= a.Start && at <= a.End) {
					t.Fatalf("arrow position/shape/time differs at %.1f pixel %d,%d", at, x, y)
				}
				checked++
			}
		}
		if checked < 100 {
			t.Fatalf("insufficient samples: %d", checked)
		}
		t.Logf("t=%.1f: %d raster samples confirm source-independent render position/shape and time", at, checked)
	}
	for i, format := range formats {
		t.Run(format.name, func(t *testing.T) {
			output := filepath.Join(dir, fmt.Sprintf("single-%d.mp4", i))
			clip := clips[i]
			clip.SourceEnd, clip.Duration = 6, 6
			args := buildAnnotatedTimelineRenderArgs([]string{inputs[i]}, []editClip{clip}, map[string]int{format.name: 0}, sources, output, nil, timeline.Annotations)
			cmd := exec.Command("ffmpeg", args...)
			cmd.Dir = dir
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("render: %v %s", err, out)
			}
			for _, at := range []float64{.1, 1, 5.9} {
				checkFrame(t, output, at)
			}
		})
	}
	t.Run("known-mixed-source-SAR-mismatch", func(t *testing.T) {
		args := buildAnnotatedTimelineRenderArgs(inputs, clips, indexes, sources, filepath.Join(dir, "mixed.mp4"), nil, timeline.Annotations)
		cmd := exec.Command("ffmpeg", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		// Known independent defect: scaling 9:16 to an even raster changes SAR.
		// Keep this explicit witness until a separately authorized SAR fix.
		if err == nil || !strings.Contains(string(out), "SAR") || !strings.Contains(string(out), "do not match") {
			t.Fatalf("expected known concat SAR failure, got %v: %s", err, out)
		}
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "do not match") {
				t.Log(line)
			}
		}
	})
}

func TestArrowRenderGeometry(t *testing.T) {
	a := editorAnnotation{X: 10, Y: 20, Width: 30, Height: 40}
	for _, size := range [][2]int{{1920, 1080}, {640, 480}} {
		for _, angle := range []float64{0, 37, 90, 225, 359.999} {
			a.Rotation = angle
			points := arrowVertices(a, size[0], size[1])
			// Independently calculate the rotated tip in SVG coordinates, then
			// apply the non-square viewport scaling used by the preview.
			radians := angle * math.Pi / 180
			wantX := (a.X + a.Width*(.5+.44*math.Cos(radians))) * float64(size[0]) / 100
			wantY := (a.Y + a.Height*(.5+.44*math.Sin(radians))) * float64(size[1]) / 100
			if math.Abs(points[3].x-wantX) > 1e-8 || math.Abs(points[3].y-wantY) > 1e-8 {
				t.Fatalf("tip at %v°: %+v", angle, points[3])
			}
			bounds := arrowBounds(a, size[0], size[1])
			for _, p := range points {
				if p.x < float64(bounds.Min.X) || p.x > float64(bounds.Max.X) || p.y < float64(bounds.Min.Y) || p.y > float64(bounds.Max.Y) {
					t.Fatalf("vertex escaped: %+v", p)
				}
			}
		}
	}
	for _, xy := range [][2]float64{{0, 0}, {70, 0}, {0, 60}, {70, 60}} {
		a.X, a.Y = xy[0], xy[1]
		for angle := 0.; angle < 360; angle += 1.37 {
			a.Rotation = angle
			for _, p := range arrowVertices(a, 1920, 1080) {
				if p.x < 0 || p.y < 0 || p.x > 1920 || p.y > 1080 {
					t.Fatalf("arrow escaped frame: %+v", p)
				}
			}
		}
	}
}

func TestCirclePersistenceWithExport(t *testing.T) {
	timeline := validTimeline(editClip{ID: "clip", SourceID: "source", SourceEnd: 2, Duration: 2})
	circle := editorAnnotation{ID: "circle", Type: "circle", X: 10, Y: 20, Width: 30, Height: 20, Start: .5, End: 1.5}
	arrow := editorAnnotation{ID: "arrow", Type: "arrow", X: 5, Y: 5, Width: 20, Height: 20, End: 2, Rotation: 37, Color: "#123456"}
	timeline.Annotations = []editorAnnotation{circle, arrow}
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(timeline)
	if err != nil {
		t.Fatal(err)
	}
	var restored editTimeline
	if err := json.Unmarshal(data, &restored); err != nil || !reflect.DeepEqual(restored, timeline) {
		t.Fatalf("mixed persistence failed: %v", err)
	}
	dir := t.TempDir()
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 || entries[0].Name() != "arrow-0.png" || entries[1].Name() != "circle-1.png" {
		t.Fatalf("incorrect annotation assets: %v", entries)
	}
	args := func(annotations []editorAnnotation) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"source.mp4"}, timeline.Clips, map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, "out.mp4", nil, annotations)
	}
	if reflect.DeepEqual(args([]editorAnnotation{circle}), args(nil)) {
		t.Fatal("circle missing from render")
	}
	if !reflect.DeepEqual(args(timeline.Annotations), args([]editorAnnotation{arrow, circle})) {
		t.Fatal("circle must render after arrows independent of stored order")
	}
}

func TestArrowRasterColorsAndShape(t *testing.T) {
	for _, test := range []struct {
		hex  string
		want color.NRGBA
	}{
		{"", color.NRGBA{252, 38, 103, 255}}, {"#12ab34", color.NRGBA{18, 171, 52, 255}},
	} {
		a := editorAnnotation{Width: 100, Height: 100, Color: test.hex}
		img := rasterArrow(a, 100, 100)
		if img.NRGBAAt(20, 50) != test.want || img.NRGBAAt(75, 50) != test.want {
			t.Fatal("shaft/head color mismatch")
		}
		for _, p := range []image.Point{{0, 0}, {20, 30}, {80, 30}, {97, 50}} {
			if img.NRGBAAt(p.X, p.Y).A != 0 {
				t.Fatalf("unexpected fill at %v", p)
			}
		}
		// Real diagonal edge coverage, not a rectangular substitute.
		partial := false
		for y := 0; y < 100; y++ {
			for x := 0; x < 100; x++ {
				alpha := img.NRGBAAt(x, y).A
				partial = partial || (alpha > 0 && alpha < 255)
			}
		}
		if !partial {
			t.Fatal("missing antialiasing")
		}
	}
}

func TestPrepareArrowFiles(t *testing.T) {
	timeline := validTimeline(editClip{ID: "clip", SourceID: "source", SourceEnd: 2})
	timeline.Annotations = []editorAnnotation{{ID: "../../not-a-filename", Type: "arrow", X: 10, Y: 10, Width: 20, Height: 30, Start: .5, End: 1.5, Rotation: 37, Color: "#ff9900"}}
	dir := t.TempDir()
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(dir, arrowFilename(0)))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds() != image.Rect(0, 0, 384, 324) {
		t.Fatalf("wrong image dimensions: %v", img.Bounds())
	}
	info, _ := f.Stat()
	if info.Mode().Perm() != 0600 {
		t.Fatal("sidecar must be private")
	}
	timeline.Annotations[0].Color = "red;[vout]"
	if err := prepareArrowFiles(t.TempDir(), timeline); err == nil {
		t.Fatal("invalid color accepted")
	}
	timeline.Annotations[0].Color = ""
	timeline.Annotations[0].Width = math.Inf(1)
	if err := prepareArrowFiles(t.TempDir(), timeline); err == nil {
		t.Fatal("invalid geometry accepted")
	}
}

func TestBuildAnnotatedTimelineRenderArgs(t *testing.T) {
	inputs := []string{"source.mp4"}
	clips := []editClip{{SourceID: "source", SourceEnd: 2, Duration: 2}}
	indexes := map[string]int{"source": 0}
	sources := map[string]sourceVideo{"source": {}}
	covers := []editorCoverOverlay{{Mode: "blur", Width: 20, Height: 20, End: 2}, {X: 10, Y: 20, Width: 30, Height: 40, End: 2, Text: "Text"}}
	for _, overlays := range [][]editorCoverOverlay{nil, covers} {
		base := buildTimelineRenderArgs(inputs, clips, indexes, sources, "out.mp4", overlays)
		if !reflect.DeepEqual(base, buildAnnotatedTimelineRenderArgs(inputs, clips, indexes, sources, "out.mp4", overlays, nil)) {
			t.Fatal("legacy rendering changed")
		}
		arrows := []editorAnnotation{{Type: "arrow", X: 10, Y: 20, Width: 30, Height: 40, Start: .125, End: 1.625, Rotation: 37}, {Type: "arrow", X: 50, Y: 60, Width: 10, Height: 20, Start: 1, End: 2, Color: "#00ff00", Rotation: 225}}
		args := buildAnnotatedTimelineRenderArgs(inputs, clips, indexes, sources, "out.mp4", overlays, arrows)
		joined := strings.Join(args, " ")
		for _, want := range []string{"-loop 1 -framerate 30 -i arrow-0.png", "-i arrow-1.png", "[varrowbase][1:v]overlay=x=192:y=216", "[varrow0rgb][2:v]overlay=x=960:y=648", "between(t,0.125000,1.625000)", "between(t,1.000000,2.000000)", "format=yuv420p[vout]"} {
			if !strings.Contains(joined, want) {
				t.Fatalf("missing %s: %s", want, joined)
			}
		}
		if overlays != nil && strings.Index(joined, "drawtext=") > strings.Index(joined, "[varrowbase][1:v]") {
			t.Fatal("arrow must follow text")
		}
	}
}

func TestTimelineArrowRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "black.mp4")
	output := filepath.Join(dir, "arrows.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v: %s", err, out)
	}
	arrows := []editorAnnotation{
		{ID: "pink", Type: "arrow", X: 5, Y: 5, Width: 30, Height: 35, Start: .5, End: 1.5, Rotation: 0},
		{ID: "green", Type: "arrow", X: 55, Y: 5, Width: 35, Height: 30, Start: .5, End: 1.5, Rotation: 37, Color: "#00ff00"},
		{ID: "blue", Type: "arrow", X: 5, Y: 55, Width: 30, Height: 40, Start: .5, End: 1.5, Rotation: 90, Color: "#0000ff"},
		{ID: "yellow", Type: "arrow", X: 60, Y: 55, Width: 40, Height: 45, Start: .75, End: 1.25, Rotation: 225, Color: "#ffff00"},
	}
	timeline := validTimeline(editClip{ID: "clip", SourceID: "source", SourceEnd: 2, Duration: 2})
	timeline.Annotations = arrows
	// Covers would hide the arrows if their order were accidentally reversed.
	timeline.Overlays = []editorCoverOverlay{{ID: "blur", Mode: "blur", Width: 100, Height: 100, End: 2}, {ID: "cover", Width: 100, Height: 100, End: 2}}
	font := editorTextFont
	if localFont := os.Getenv("SENDREC_TEST_DEJAVU_FONT"); localFont != "" {
		font = localFont
	}
	if _, err := os.Stat(font); err == nil {
		// The glyph lies entirely underneath the pink arrow's shaft. If text
		// were rendered after annotations, these pixels would turn white.
		timeline.Overlays = append(timeline.Overlays, editorCoverOverlay{ID: "text", X: 5, Y: 5, Width: 30, Height: 35, Start: .5, End: 1.5, Text: "A"})
		if err := prepareCoverTextFiles(dir, timeline.Overlays); err != nil {
			t.Fatal(err)
		}
	}
	if err := prepareArrowFiles(dir, timeline); err != nil {
		t.Fatal(err)
	}
	args := buildAnnotatedTimelineRenderArgs([]string{input}, timeline.Clips, map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, output, timeline.Overlays, arrows)
	for i, arg := range args {
		if arg == "-filter_complex" {
			args[i+1] = strings.ReplaceAll(args[i+1], editorTextFont, font)
			break
		}
	}
	cmd := exec.Command("ffmpeg", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("arrow render: %v: %s", err, out)
	}
	for _, at := range []string{"0.25", "0.6", "1.0", "1.4", "1.75"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("sample %s: %v (%d bytes)", at, err, len(pixels))
		}
		for i, a := range arrows {
			bounds := arrowBounds(a, 1920, 1080)
			mask := rasterArrow(a, 1920, 1080)
			active := at != "0.25" && at != "1.75" && (i != 3 || at == "1.0")
			checked := 0
			for y := 3; y < bounds.Dy()-3; y += 7 {
				for x := 3; x < bounds.Dx()-3; x += 7 {
					want := mask.NRGBAAt(x, y)
					// Stay clear of the antialiased edge / chroma subsampling.
					if want.A != 255 || mask.NRGBAAt(x-3, y).A != 255 || mask.NRGBAAt(x+3, y).A != 255 || mask.NRGBAAt(x, y-3).A != 255 || mask.NRGBAAt(x, y+3).A != 255 {
						continue
					}
					if !active {
						want = color.NRGBA{}
					}
					p := ((bounds.Min.Y+y)*1920 + bounds.Min.X + x) * 3
					for c, v := range []uint8{want.R, want.G, want.B} {
						if math.Abs(float64(pixels[p+c])-float64(v)) > 35 {
							t.Fatalf("arrow %d pixel %d,%d at %s: got %v want %v", i, x, y, at, pixels[p:p+3], want)
						}
					}
					checked++
				}
			}
			if checked < 10 {
				t.Fatal("insufficient shape samples")
			}
		}
		// Nothing outside annotation boxes may be painted.
		for y := 0; y < 1080; y += 13 {
			for x := 0; x < 1920; x += 13 {
				inside := false
				for _, a := range arrows {
					inside = inside || image.Pt(x, y).In(arrowBounds(a, 1920, 1080).Inset(-3))
				}
				if inside {
					continue
				}
				p := (y*1920 + x) * 3
				if pixels[p] > 20 || pixels[p+1] > 20 || pixels[p+2] > 20 {
					t.Fatalf("paint outside arrows at %d,%d", x, y)
				}
			}
		}
	}
}
