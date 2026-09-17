package video

import (
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Regression matrix retained from the SAR/concat diagnosis; exercises the
// production graph and measures display geometry, not only encoder success.
func TestTimelineConcatParameterRegression(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	dir := t.TempDir()
	fixture := func(name, filter string) string {
		path := filepath.Join(dir, name+".mkv")
		codec := []string{"-c:v", "ffv1"}
		if name == "different-timebase" {
			path = filepath.Join(dir, name+".mp4")
			codec = []string{"-c:v", "libx264", "-video_track_timescale", "90000"}
		}
		args := append([]string{"-v", "error", "-f", "lavfi", "-i", filter}, codec...)
		if out, err := exec.Command("ffmpeg", append(args, "-y", path)...).CombinedOutput(); err != nil {
			t.Fatalf("fixture: %v %s", err, out)
		}
		return path
	}
	base := fixture("base", "testsrc2=s=160x90:r=30:d=1,setsar=1")
	for _, tc := range []struct {
		name, filter    string
		dar             float64
		legacyIdentical bool
	}{
		{"16x9-different-sar", "color=white:s=160x90:r=30:d=1,setsar=16/15", 256.0 / 135, false},
		{"4x3", "color=white:s=160x120:r=30:d=1,setsar=1", 4.0 / 3, false},
		{"portrait", "color=white:s=90x160:r=30:d=1,setsar=1", 9.0 / 16, false},
		{"different-resolution", "color=white:s=320x180:r=30:d=1,setsar=1", 16.0 / 9, true},
		{"rounded-resolution", "color=white:s=854x480:r=30:d=1,setsar=1", 854.0 / 480, false},
		{"wide", "color=white:s=240x100:r=30:d=1,setsar=1", 2.4, false},
		{"anamorphic-pal", "color=white:s=720x576:r=25:d=1,setsar=16/15", 4.0 / 3, false},
		{"anamorphic-wide", "color=white:s=720x576:r=25:d=1,setsar=64/45", 16.0 / 9, false},
		{"25fps", "color=white:s=160x90:r=25:d=1,setsar=1", 16.0 / 9, true},
		{"fractional-fps", "color=white:s=160x90:r=30000/1001:d=1,setsar=1", 16.0 / 9, true},
		{"pixel-format", "color=white:s=160x90:r=60:d=1,setsar=1,format=yuv444p", 16.0 / 9, true},
		{"different-timebase", "color=white:s=160x90:r=30:d=1,setsar=1", 16.0 / 9, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			other := fixture(tc.name, tc.filter)
			clips := []editClip{{ID: "a", SourceID: "a", SourceEnd: 1, Duration: 1}, {ID: "b", SourceID: "b", SourceEnd: 1, Duration: 1}}
			output := filepath.Join(dir, tc.name+"-rendered.mp4")
			args := buildTimelineRenderArgs([]string{base, other}, clips, map[string]int{"a": 0, "b": 1}, map[string]sourceVideo{"a": {}, "b": {}}, output)
			gi := 0
			for args[gi] != "-filter_complex" {
				gi++
			}
			gi++
			graph := args[gi]
			args[gi] = strings.ReplaceAll(graph, "format=yuv420p[v", "format=yuv420p,showinfo[v")
			out, err := exec.Command("ffmpeg", args...).CombinedOutput()
			if err != nil {
				t.Fatalf("concat: %v %s\ngraph: %s", err, out, graph)
			}
			firstFrames := 0
			for _, line := range strings.Split(string(out), "\n") {
				if strings.Contains(line, "n:   0") {
					firstFrames++
					for _, want := range []string{"sar:1/1", "s:1920x1080", "fmt:yuv420p", "pts:      0"} {
						if !strings.Contains(line, want) {
							t.Fatal(line)
						}
					}
				}
			}
			if firstFrames != 2 || strings.Count(string(out), "config in time_base: 1/30, frame_rate: 30/1") != 2 {
				t.Fatal("pre-concat format/timing mismatch", string(out))
			}
			// Measure the white source's complete visible content bounds after concat.
			pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", "1.5", "-i", output, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-").Output()
			if err != nil || len(pixels) != 1920*1080 {
				t.Fatal("decode", err)
			}
			left, right, top, bottom := 1920, -1, 1080, -1
			for y := 0; y < 1080; y++ {
				for x := 0; x < 1920; x++ {
					if pixels[y*1920+x] > 180 {
						if x < left {
							left = x
						}
						if x > right {
							right = x
						}
						if y < top {
							top = y
						}
						if y > bottom {
							bottom = y
						}
					}
				}
			}
			w, h := right-left+1, bottom-top+1
			idealW, idealH := 1920.0, 1920/tc.dar
			if idealH > 1080 {
				idealW, idealH = 1080*tc.dar, 1080
			}
			if math.Abs(float64(w)-idealW) > 1.1 || math.Abs(float64(h)-idealH) > 1.1 {
				t.Fatalf("DAR %.8f: content %dx%d, ideal %.4fx%.4f", tc.dar, w, h, idealW, idealH)
			}
			if math.Abs(float64(left-(1920-w)/2)) > 1 || math.Abs(float64(top-(1080-h)/2)) > 1 {
				t.Fatal("padding not centered")
			}
			t.Logf("content %dx%d at %d,%d; source DAR %.8f; output SAR 1:1", w, h, left, top, tc.dar)
			if tc.legacyIdentical {
				assertLegacyPixels(t, other, strings.TrimSuffix(strings.TrimPrefix(strings.Split(graph, ";")[1], "[1:v]"), "[v1]"))
			}
			// Compare textured frames, not just uniform white, against the old filter.
			if tc.name == "different-resolution" {
				assertLegacyPixels(t, base, strings.TrimSuffix(strings.TrimPrefix(strings.Split(graph, ";")[0], "[0:v]"), "[v0]"))
			}
		})
	}
}

func assertLegacyPixels(t *testing.T, input, chain string) {
	t.Helper()
	start, end := strings.Index(chain, "scale="), strings.Index(chain, ",pad=")
	old := chain[:start] + "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2" + chain[end:]
	var hashes []string
	for _, filter := range []string{old, chain} {
		out, err := exec.Command("ffmpeg", "-v", "error", "-i", input, "-vf", filter, "-f", "hash", "-hash", "sha256", "-").CombinedOutput()
		if err != nil {
			t.Fatalf("hash: %v %s", err, out)
		}
		hashes = append(hashes, string(out))
	}
	if hashes[0] != hashes[1] {
		t.Fatal("square-pixel 16:9 raster changed", hashes)
	}
}
