package video

import (
	"encoding/binary"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestAudioRenderGraphAndLegacy(t *testing.T) {
	clips := []editClip{{ID: "a", SourceID: "s", SourceStart: 2, SourceEnd: 3, Duration: 1}, {ID: "b", SourceID: "other", SourceStart: 1, SourceEnd: 2, Duration: 1}, {ID: "c", SourceID: "s", SourceStart: 4, SourceEnd: 5, Duration: 1}}
	sources := map[string]sourceVideo{"s": {HasAudio: true}, "other": {HasAudio: true}}
	indexes := map[string]int{"s": 0, "other": 1}
	audio := renderAudioSegments(clips, nil)
	if audio[1].TimelineStart != 1 || audio[2].SourceStart != 4 {
		t.Fatal(audio)
	}
	args := func(a *[]editorAudioSegment) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"s.mp4", "other.mp4"}, clips, indexes, sources, "out.mp4", nil, nil, a)
	}
	if !reflect.DeepEqual(args(nil), args(&audio)) {
		t.Fatal("legacy and coupled audio differ")
	}
	graph := strings.Join(args(&audio), " ")
	for _, want := range []string{"[v0][v1][v2]concat=n=3:v=1:a=0", "[0:a:0]atrim=start=2.000000000", "[1:a:0]atrim=start=1.000000000", "[0:a:0]atrim=start=4.000000000", "channel_layouts=stereo", "-map [vout] -map [aout]"} {
		if !strings.Contains(graph, want) {
			t.Fatal("missing", want, graph)
		}
	}
	if strings.Contains(graph, "v=1:a=1") || strings.Count(graph, "-map [aout]") != 1 {
		t.Fatal("duplicate audio", graph)
	}
	empty := []editorAudioSegment{}
	graph = strings.Join(args(&empty), " ")
	if strings.Contains(graph, ":a:0]") || !strings.Contains(graph, "anullsrc") {
		t.Fatal("empty audio is not silent", graph)
	}
}

func TestAudioRenderValidationAndSources(t *testing.T) {
	base := editorAudioSegment{ID: "audio", SourceClipID: "clip", SourceVideoID: "sound", SourceStart: 0, SourceEnd: 1, TimelineStart: 1}
	timeline := validTimeline(editClip{ID: "clip", SourceID: "video", SourceEnd: 4, Duration: 4})
	sources := map[string]sourceVideo{"video": {Duration: 4}, "sound": {Duration: 4}}
	for _, tc := range []struct {
		name   string
		change func(*editorAudioSegment)
	}{
		{"negative", func(s *editorAudioSegment) { s.SourceStart = -1 }},
		{"reversed", func(s *editorAudioSegment) { s.SourceEnd = -1 }},
		{"nan", func(s *editorAudioSegment) { s.TimelineStart = math.NaN() }},
		{"source", func(s *editorAudioSegment) { s.SourceEnd = 5 }},
		{"timeline", func(s *editorAudioSegment) { s.TimelineStart = 4 }},
		{"unavailable", func(s *editorAudioSegment) { s.SourceVideoID = "missing" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := base
			tc.change(&s)
			a := []editorAudioSegment{s}
			timeline.AudioSegments = &a
			if validateRenderAudio(timeline, sources) == nil {
				t.Fatal("accepted invalid audio")
			}
		})
	}
	audio := []editorAudioSegment{base, base}
	timeline.AudioSegments = &audio
	if validateRenderAudio(timeline, sources) == nil {
		t.Fatal("overlap accepted")
	}
	audio[1].TimelineStart = 2
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal(err)
	}
	audio[1].TimelineStart = 1.9995
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal("rounding tolerance", err)
	}
	audio[1].SourceEnd = audio[1].SourceStart
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal("zero duration", err)
	}
	if !reflect.DeepEqual(renderSourceIDs(timeline), []string{"video", "sound"}) {
		t.Fatal("audio-only source missing or duplicated")
	}
	// Sorting and render fallback must not mutate the persisted model.
	audio = []editorAudioSegment{{TimelineStart: 3, SourceVideoID: "sound", SourceEnd: .5}, base}
	before := append([]editorAudioSegment{}, audio...)
	_ = timelineAudioFilters(timeline.Clips, &audio, map[string]int{"sound": 0}, sources)
	if !reflect.DeepEqual(before, audio) {
		t.Fatal("stored ordering changed")
	}
}

func TestAudioMuteGraph(t *testing.T) {
	clips := []editClip{{ID: "c", SourceID: "main", SourceEnd: 3, Duration: 3}}
	sources := map[string]sourceVideo{"main": {HasAudio: true}}
	indexes := map[string]int{"main": 0}
	audio := []editorAudioSegment{
		{ID: "a", SourceVideoID: "main", SourceEnd: 1},
		{ID: "b", SourceVideoID: "main", SourceStart: 1, SourceEnd: 2, TimelineStart: 1, Muted: true},
		{ID: "c", SourceVideoID: "main", SourceStart: 2, SourceEnd: 3, TimelineStart: 2},
	}
	before := append([]editorAudioSegment{}, audio...)
	graph := strings.Join(timelineAudioFilters(clips, &audio, indexes, sources), ";")
	if strings.Count(graph, "[0:a:0]") != 2 || !strings.Contains(graph, "anullsrc=r=48000:cl=stereo,atrim=end_sample=48000") || !strings.Contains(graph, "atrim=start=2.000000000") {
		t.Fatal(graph)
	}
	if !reflect.DeepEqual(before, audio) {
		t.Fatal("mute changed geometry")
	}
	only := []editorAudioSegment{{SourceVideoID: "main", SourceEnd: 3, Muted: true}}
	graph = strings.Join(timelineAudioFilters(clips, &only, indexes, sources), ";")
	if strings.Contains(graph, ":a:0]") || !strings.Contains(graph, "atrim=end_sample=144000") {
		t.Fatal(graph)
	}
	for i := range audio {
		audio[i].Muted = false
	}
	graph = strings.Join(timelineAudioFilters(clips, &audio, indexes, sources), ";")
	if strings.Count(graph, "[0:a:0]") != 3 {
		t.Fatal("unmute failed", graph)
	}
}

func TestAudioVolumeValidationAndGraph(t *testing.T) {
	clips := []editClip{{ID: "c", SourceID: "main", SourceEnd: 3, Duration: 3}}
	sources := map[string]sourceVideo{"main": {HasAudio: true, Duration: 3}}
	indexes := map[string]int{"main": 0}
	base := editorAudioSegment{ID: "a", SourceClipID: "c", SourceVideoID: "main", SourceEnd: 3}
	audio := []editorAudioSegment{base}
	legacy := strings.Join(timelineAudioFilters(clips, &audio, indexes, sources), ";")
	for _, value := range []float64{0, 0.5, 1, -0.1, 1.1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		audio[0] = base
		audio[0].Volume = &value
		timeline := editTimeline{Version: 1, Clips: clips, AudioSegments: &audio}
		invalid := math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1
		if (validateEditTimeline(&timeline) != nil) != invalid || (validateRenderAudio(timeline, sources) != nil) != invalid {
			t.Fatalf("validation: %g", value)
		}
		if invalid {
			continue
		}
		graph := strings.Join(timelineAudioFilters(clips, &audio, indexes, sources), ";")
		if value == 1 && graph != legacy {
			t.Fatal("100 percent changed legacy path")
		}
		if value != 1 && !strings.Contains(graph, fmt.Sprintf("channel_layouts=stereo,volume=%.9f,apad", value)) {
			t.Fatal(graph)
		}
		audio[0].Muted = true
		graph = strings.Join(timelineAudioFilters(clips, &audio, indexes, sources), ";")
		if strings.Contains(graph, ":a:0]") || !strings.Contains(graph, "anullsrc") {
			t.Fatal("mute lost priority")
		}
	}
}

func TestAudioTimelineFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("ffmpeg", append([]string{"-v", "error"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v %s", err, out)
		}
	}
	inputs := []string{filepath.Join(dir, "main.mkv"), filepath.Join(dir, "short.mkv"), filepath.Join(dir, "silent.mkv")}
	for i, path := range inputs {
		args := []string{"-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=4"}
		if i < 2 {
			d := 4.
			if i == 1 {
				d = .25
			}
			args = append(args, "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=%d:duration=%g", 440*(i+1), []int{44100, 48000}[i], d), "-ac", []string{"1", "2"}[i], "-c:a", "pcm_s16le")
		}
		run(append(args, "-c:v", "libx264", "-y", path)...)
	}
	sources := map[string]sourceVideo{"main": {Duration: 4, HasAudio: probeHasAudio(inputs[0])}, "short": {Duration: 4, HasAudio: probeHasAudio(inputs[1])}, "silent": {Duration: 4, HasAudio: probeHasAudio(inputs[2])}}
	indexes := map[string]int{"main": 0, "short": 1, "silent": 2}
	clips := []editClip{{ID: "c", SourceID: "main", SourceEnd: 4, Duration: 4}}
	segments := []editorAudioSegment{
		{ID: "repeat", SourceClipID: "c", SourceVideoID: "main", SourceStart: 1, SourceEnd: 1.5, TimelineStart: 2.4},
		{ID: "first", SourceClipID: "c", SourceVideoID: "main", SourceEnd: .5, TimelineStart: .3},
		{ID: "short", SourceClipID: "c", SourceVideoID: "short", SourceEnd: .6, TimelineStart: 1},
		{ID: "silent", SourceClipID: "c", SourceVideoID: "silent", SourceEnd: .4, TimelineStart: 1.8},
	}
	empty := []editorAudioSegment{}
	muted := []editorAudioSegment{
		{ID: "a", SourceClipID: "c", SourceVideoID: "main", SourceEnd: 1},
		{ID: "b", SourceClipID: "c", SourceVideoID: "main", SourceStart: 1, SourceEnd: 2, TimelineStart: 1, Muted: true},
		{ID: "c", SourceClipID: "c", SourceVideoID: "main", SourceStart: 2, SourceEnd: 4, TimelineStart: 2},
	}
	allMuted := []editorAudioSegment{{ID: "only", SourceClipID: "c", SourceVideoID: "main", SourceEnd: 4, Muted: true}}
	half, zero := 0.5, 0.0
	volume := append([]editorAudioSegment{}, muted...)
	volume[1].Muted = false
	volume[1].Volume = &half
	zeroVolume := []editorAudioSegment{{ID: "zero", SourceClipID: "c", SourceVideoID: "main", SourceEnd: 4, Volume: &zero}}
	for _, tc := range []struct {
		name  string
		audio *[]editorAudioSegment
	}{{"segments", &segments}, {"empty", &empty}, {"legacy", nil}, {"muted", &muted}, {"all-muted", &allMuted}, {"volume", &volume}, {"zero-volume", &zeroVolume}} {
		t.Run(tc.name, func(t *testing.T) {
			output := filepath.Join(dir, tc.name+".mp4")
			run(buildAnnotatedTimelineRenderArgs(inputs, clips, indexes, sources, output, nil, nil, tc.audio)...)
			pcm, err := exec.Command("ffmpeg", "-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1").Output()
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(float64(len(pcm)/2)/48000-4) > .025 {
				t.Fatal("incorrect audio duration", len(pcm))
			}
			measure := func(at float64) (float64, float64) {
				first := int(at * 48000)
				n := 4800
				sum := 0.
				cross := 0
				last := int16(0)
				for i := 0; i < n; i++ {
					v := int16(binary.LittleEndian.Uint16(pcm[(first+i)*2:]))
					sum += float64(v) * float64(v)
					if i > 0 && last <= 0 && v > 0 {
						cross++
					}
					last = v
				}
				return math.Sqrt(sum/float64(n)) / 32768, float64(cross) * 10
			}
			for _, at := range []float64{.05, .4, .85, 1.05, 1.4, 1.9, 2.5, 3.5} {
				rms, freq := measure(at)
				want := 0.
				gain := 1.0
				if tc.name == "volume" {
					want = 440
					if at >= 1 && at < 2 {
						gain = 0.5
					}
				}
				if tc.name == "legacy" {
					want = 440
				}
				if tc.name == "muted" && (at < 1 || at >= 2) {
					want = 440
				}
				if tc.name == "segments" {
					if at == .4 || at == 2.5 {
						want = 440
					}
					if at == 1.05 {
						want = 880
					}
				}
				if want == 0 {
					if rms > .001 {
						t.Fatalf("expected silence at %g, rms=%g", at, rms)
					}
				} else if rms < .04*gain || rms > .10*gain || math.Abs(freq-want) > 20 {
					t.Fatalf("tone/level at %g: rms=%g freq=%g want=%g", at, rms, freq, want)
				}
			}
			probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", output).Output()
			if err != nil || strings.TrimSpace(string(probe)) != "aac" {
				t.Fatal("expected exactly one AAC stream", string(probe), err)
			}
		})
	}
}
