package video

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// PCM output accepts an unnamed two-channel layout; the real AAC encoder does
// not. Include original-track gaps/concat, which expose layout negotiation.
func TestDuckingRenderAACWithGaps(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "off", true: "on"}[enabled], func(t *testing.T) {
			timeline, sources, indexes := duckingFixture()
			timeline.DuckOriginalAudio = &enabled
			original := &(*timeline.AudioSegments)[0]
			unlinked, speed := false, 1.0
			original.GeometryLinked, original.Speed = &unlinked, &speed
			original.TimelineStart, original.SourceEnd = .2, 1
			graph := strings.Join(timelineAudioFilters(timeline.Clips, timeline.AudioSegments, indexes, sources), ";")
			output := filepath.Join(t.TempDir(), "mixed.m4a")
			args := []string{"-v", "error", "-f", "lavfi", "-i", "sine=r=48000:d=4", "-f", "lavfi", "-i", "sine=r=48000:d=2", "-filter_complex", graph, "-map", "[aout]", "-c:a", "aac", "-y", output}
			if out, err := exec.Command("ffmpeg", applyTimelineDucking(args, timeline)...).CombinedOutput(); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			raw, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,channel_layout,duration", "-of", "json", output).Output()
			if err != nil {
				t.Fatal(err)
			}
			var probe struct {
				Streams []struct {
					SampleRate string `json:"sample_rate"`
					Channels   int    `json:"channels"`
					Layout     string `json:"channel_layout"`
					Duration   string `json:"duration"`
				} `json:"streams"`
			}
			if err := json.Unmarshal(raw, &probe); err != nil {
				t.Fatal(err)
			}
			if len(probe.Streams) != 1 || probe.Streams[0].SampleRate != "48000" || probe.Streams[0].Channels != 2 || probe.Streams[0].Layout != "stereo" || probe.Streams[0].Duration != "2.000000" {
				t.Fatalf("unexpected AAC metadata: %s", raw)
			}
		})
	}
}

func duckingFixture() (editTimeline, map[string]sourceVideo, map[string]int) {
	timeline, sources, indexes := multitrackFixture()
	yes := true
	timeline.DuckOriginalAudio = &yes
	return timeline, sources, indexes
}

func TestDuckingWindows(t *testing.T) {
	voice := "voiceover-1"
	rate := 2.0
	for _, tc := range []struct {
		name     string
		segments []editorAudioSegment
		want     []audioDuckingWindow
	}{
		{"move-trim-speed", []editorAudioSegment{{TrackID: &voice, TimelineStart: 3, SourceStart: 2, SourceEnd: 4, Speed: &rate}}, []audioDuckingWindow{{3, 4}}},
		{"muted", []editorAudioSegment{{TrackID: &voice, SourceEnd: 2, Muted: true}}, nil},
		{"original", []editorAudioSegment{{SourceEnd: 2}}, nil},
		{"empty", []editorAudioSegment{{TrackID: &voice, SourceStart: 2, SourceEnd: 2}}, nil},
		{"overlap-touch-unsorted", []editorAudioSegment{
			{TrackID: &voice, TimelineStart: 3, SourceEnd: 1},
			{TrackID: &voice, TimelineStart: 1, SourceEnd: 1.5},
			{TrackID: &voice, TimelineStart: 2, SourceEnd: 1},
		}, []audioDuckingWindow{{1, 4}}},
		{"gap", []editorAudioSegment{{TrackID: &voice, SourceEnd: 1}, {TrackID: &voice, TimelineStart: 2, SourceEnd: 1}}, []audioDuckingWindow{{0, 1}, {2, 3}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			timeline := editTimeline{AudioSegments: &tc.segments}
			if got := audioDuckingWindows(timeline); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestDuckingRenderCompatibility(t *testing.T) {
	timeline, sources, indexes := duckingFixture()
	build := func(timeline editTimeline) []string {
		return buildAnnotatedTimelineRenderArgs([]string{"video", "asset"}, timeline.Clips, indexes, sources, "output", timeline.Overlays, timeline.Annotations, timeline.AudioSegments)
	}
	for _, state := range []*bool{nil, new(bool)} {
		timeline.DuckOriginalAudio = state
		args := build(timeline)
		if !reflect.DeepEqual(args, applyTimelineDucking(args, timeline)) {
			t.Fatal("disabled/legacy graph changed")
		}
	}
	yes := true
	timeline.DuckOriginalAudio = &yes
	for _, tc := range []string{"original-only", "voice-only", "muted-voice", "empty", "legacy"} {
		t.Run(tc, func(t *testing.T) {
			copy := timeline
			segments := append([]editorAudioSegment(nil), (*timeline.AudioSegments)...)
			switch tc {
			case "original-only":
				segments = segments[:1]
			case "voice-only":
				segments = segments[1:]
			case "muted-voice":
				segments[1].Muted = true
			case "empty":
				segments = nil
			}
			copy.AudioSegments = &segments
			if tc == "legacy" {
				copy.AudioSegments = nil
			}
			args := build(copy)
			if !reflect.DeepEqual(args, applyTimelineDucking(args, copy)) {
				t.Fatal("unnecessary graph change")
			}
		})
	}
	volume := .8
	(*timeline.AudioSegments)[0].Volume = &volume
	args := build(timeline)
	before, _ := json.Marshal(timeline)
	result := applyTimelineDucking(args, timeline)
	graph := strings.Join(result, " ")
	if !strings.Contains(graph, "volume=0.800000000") || !strings.Contains(graph, "[mix0]aeval=") || !strings.Contains(graph, "[duckedOriginal][mix1]amix=") {
		t.Fatal(graph)
	}
	if strings.Contains(strings.Join(args, " "), "aeval=") {
		t.Fatal("input arguments mutated")
	}
	after, _ := json.Marshal(timeline)
	if string(before) != string(after) {
		t.Fatal("persisted values mutated")
	}
}

// Exercise the actual generated audio graph, decoded to float PCM. Constant
// inputs let us measure both channels sample-exactly, including the fade edges.
func TestDuckingRenderFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	for _, tc := range []struct {
		name                    string
		originalMute, voiceMute bool
		start, duration         float64
	}{
		{"fades-volume", false, false, .5, 1},
		{"short", false, false, .5, .1},
		{"move-trim", false, false, .8, .4},
		{"original-muted", true, false, .5, 1},
		{"voice-muted", false, true, .5, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			timeline, sources, indexes := duckingFixture()
			// Preserve existing speed handling (original speed 2) and source trim.
			volume, voiceVolume := .8, .5
			segments := *timeline.AudioSegments
			segments[0].Volume, segments[0].Muted = &volume, tc.originalMute
			segments[1].Volume, segments[1].Muted = &voiceVolume, tc.voiceMute
			segments[1].TimelineStart = tc.start
			segments[1].SourceEnd = segments[1].SourceStart + tc.duration
			graph := strings.Join(timelineAudioFilters(timeline.Clips, timeline.AudioSegments, indexes, sources), ";")
			args := []string{"-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.4|0.4:s=48000:d=4", "-f", "lavfi", "-i", "aevalsrc=0.1|0.1:s=48000:d=2", "-filter_complex", graph, "-map", "[aout]", "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"}
			cmd := exec.Command("ffmpeg", applyTimelineDucking(args, timeline)...)
			var stderr strings.Builder
			cmd.Stderr = &stderr
			raw, err := cmd.Output()
			if err != nil {
				t.Fatalf("%v: %s", err, stderr.String())
			}
			if len(raw) != 2*48000*2*4 {
				t.Fatalf("wrong duration/channel count: %d", len(raw))
			}
			fade := math.Min(.2, tc.duration/2)
			for _, time := range []float64{.3, tc.start, tc.start + fade/2, tc.start + fade, tc.start + tc.duration/2, tc.start + tc.duration - fade/2, tc.start + tc.duration, 1.9} {
				gain, voice := 1.0, 0.0
				if time >= tc.start && time < tc.start+tc.duration && !tc.voiceMute {
					gain = 1 - .75*math.Min(1, math.Min((time-tc.start)/fade, (tc.start+tc.duration-time)/fade))
					voice = .1 * .5
				}
				want := .4*.8*gain + voice
				if tc.originalMute {
					want = voice
				}
				for channel := 0; channel < 2; channel++ {
					index := (int(math.Round(time*48000))*2 + channel) * 4
					got := float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[index:])))
					if math.Abs(got-want) > .001 {
						t.Fatalf("t=%g channel=%d got=%g want=%g", time, channel, got, want)
					}
				}
			}
		})
	}
}
