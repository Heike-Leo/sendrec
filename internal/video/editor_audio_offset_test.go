package video

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestAudioOffsetFilterOrder(t *testing.T) {
	for _, start := range []float64{0, .02, .50123} {
		for _, speed := range []float64{.5, 1, 2} {
			clips := []editClip{{ID: "c", SourceID: "v", SourceEnd: 10}}
			audio := []editorAudioSegment{{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceStart: start, SourceEnd: start + 2, TimelineStart: 1, Speed: speedValue(speed), Volume: speedValue(.4)}}
			graph := strings.Join(timelineAudioFilters(clips, &audio, map[string]int{"v": 0}, map[string]sourceVideo{"v": {HasAudio: true}}), ";")
			want := fmt.Sprintf("atrim=start=%.9f:end=%.9f,asetpts=PTS-%.9f/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo", start, start+2, start)
			if speed != 1 {
				want += fmt.Sprintf(",atempo=%.9f,asetpts=PTS-STARTPTS+STARTPTS/%.9f", speed, speed)
			}
			want += ",aresample=48000:first_pts=0,volume=0.400000000,apad="
			if !strings.Contains(graph, want) || !strings.Contains(graph, "anullsrc=r=48000:cl=stereo,atrim=end_sample=48000") {
				t.Fatal(graph)
			}
		}
	}
}

// Detect signal in decoded PCM, not stream.start_time: preserved offsets are
// represented by actual silence, so the final AAC stream still starts at zero.
func TestAudioSourceOffsetFFmpegIntegration(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("ffmpeg", append([]string{"-v", "error"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg %v\nargs=%q\n%s", err, args, out)
		}
	}
	inputs := []string{filepath.Join(dir, "zero.nut"), filepath.Join(dir, "offset.nut")}
	for i, offset := range []float64{0, .057} {
		run("-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-af", fmt.Sprintf("asetpts=PTS+%.9f/TB", offset), "-c:v", "libx264", "-c:a", "pcm_s16le", "-y", inputs[i])
	}
	decode := func(path string) []byte {
		t.Helper()
		raw, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1").Output()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	onset := func(raw []byte, from, to float64) float64 {
		for i := int(math.Round(from * 48000)); i < min(len(raw)/2, int(math.Round(to*48000))); i++ {
			if math.Abs(float64(int16(binary.LittleEndian.Uint16(raw[i*2:])))) > 100 {
				return float64(i)/48000 - from
			}
		}
		return math.Inf(1)
	}
	checkDuration := func(path string, want float64) {
		t.Helper()
		raw, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path).Output()
		if err != nil {
			t.Fatal(err)
		}
		var data struct {
			Streams []struct {
				Type     string `json:"codec_type"`
				Duration string `json:"duration"`
			}
		}
		if err := json.Unmarshal(raw, &data); err != nil {
			t.Fatal(err)
		}
		if len(data.Streams) != 2 {
			t.Fatal(string(raw))
		}
		for _, s := range data.Streams {
			d, err := strconv.ParseFloat(s.Duration, 64)
			if err != nil || math.Abs(d-want) > 1.0/30+.002 {
				t.Fatalf("duration expected %.9f actual %s (%s): %v", want, s.Duration, s.Type, err)
			}
		}
	}
	// The source origin is preserved independently of WSOLA transient placement.
	// Allow 2 ms for AAC onset/ringing and sample quantization, not whole frames.
	for _, speed := range []float64{1, 2, .5} {
		for _, tc := range []struct {
			name   string
			source int
			start  float64
		}{{"zero", 0, 0}, {"late", 1, 0}, {"trim-before-first-audio", 1, .02}, {"trim-mid-source", 1, .50123}} {
			t.Run(fmt.Sprintf("%s/%g", tc.name, speed), func(t *testing.T) {
				clip := editClip{ID: "c", SourceID: "v", SourceStart: tc.start, SourceEnd: tc.start + 2, Speed: speedValue(speed)}
				path := filepath.Join(dir, fmt.Sprintf("%s-%g.mp4", tc.name, speed))
				run(buildTimelineRenderArgs([]string{inputs[tc.source]}, []editClip{clip}, map[string]int{"v": 0}, map[string]sourceVideo{"v": {HasAudio: true}}, path)...)
				want := 0.0
				if tc.source == 1 {
					want = math.Max(0, .057-tc.start) / speed
				}
				got := onset(decode(path), 0, .5)
				tolerance := .002
				t.Logf("offset expected=%.9f actual=%.9f speed=%g sourceStart=%.9f", want, got, speed, tc.start)
				if math.Abs(got-want) > tolerance {
					t.Fatalf("offset outside tolerance %.6f", tolerance)
				}
				checkDuration(path, 2/speed)
			})
		}
	}
	// Repeated offset source, an intervening different source, and mixed speeds.
	// No segment inherits elapsed time or the preceding segment's audio offset.
	clips := []editClip{{ID: "a", SourceID: "late", SourceEnd: 2, Speed: speedValue(2)}, {ID: "b", SourceID: "zero", SourceEnd: 2}, {ID: "c", SourceID: "late", SourceEnd: 2, Speed: speedValue(.5)}}
	path := filepath.Join(dir, "mixed.mp4")
	run(buildTimelineRenderArgs(inputs, clips, map[string]int{"zero": 0, "late": 1}, map[string]sourceVideo{"zero": {HasAudio: true}, "late": {HasAudio: true}}, path)...)
	raw := decode(path)
	for _, tc := range []struct{ start, want float64 }{{0, .0285}, {1, 0}, {3, .114}} {
		got := onset(raw, tc.start, tc.start+.5)
		t.Logf("mixed start=%g expected=%.9f actual=%.9f", tc.start, tc.want, got)
		if math.Abs(got-tc.want) > .002 {
			t.Fatal("mixed offset drift", tc, got)
		}
	}
	checkDuration(path, 7)
}
