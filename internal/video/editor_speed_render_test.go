package video

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pashagolub/pgxmock/v4"
)

func speedValue(v float64) *float64 { return &v }
func linkValue(v bool) *bool        { return &v }

func TestSpeedRenderFiltergraph(t *testing.T) {
	for _, speed := range []float64{.5, .75, 1, 1.25, 1.5, 2} {
		t.Run(fmt.Sprint(speed), func(t *testing.T) {
			clips := []editClip{{ID: "c", SourceID: "v", SourceStart: 2, SourceEnd: 12, Speed: speedValue(speed), Duration: 999}}
			timeline := validTimeline(clips...)
			if err := validateEditTimeline(&timeline); err != nil {
				t.Fatal(err)
			}
			if timeline.Clips[0].Duration != 10/speed {
				t.Fatal(timeline.Clips)
			}
			sources := map[string]sourceVideo{"v": {Duration: 12, HasAudio: true}}
			if err := validateRenderAudio(timeline, sources); err != nil {
				t.Fatal(err)
			}
			graph := strings.Join(buildTimelineRenderArgs([]string{"v.mp4"}, clips, map[string]int{"v": 0}, sources, "out.mp4"), " ")
			pts := "setpts=PTS-STARTPTS"
			if speed != 1 {
				pts = fmt.Sprintf("setpts=(PTS-STARTPTS)/%.9f", speed)
			}
			for _, want := range []string{"trim=start=2.000:end=12.000," + pts + ",scale=", fmt.Sprintf("fps=30,tpad=stop_mode=clone:stop_duration=%.9f,trim=duration=%.9f", 10/speed, 10/speed), fmt.Sprintf("apad=whole_len=%d,atrim=end_sample=%d", int64(math.Round(10/speed*48000)), int64(math.Round(10/speed*48000))), "concat=n=1:v=1:a=0"} {
				if !strings.Contains(graph, want) {
					t.Fatal("missing", want, graph)
				}
			}
			if speed == 1 && strings.Contains(graph, "atempo=") {
				t.Fatal(graph)
			}
			if speed != 1 && strings.Count(graph, fmt.Sprintf("atempo=%.9f", speed)) != 1 {
				t.Fatal(graph)
			}
			// Explicit 1x and legacy produce identical filters, ignoring stale duration metadata.
			if speed == 1 {
				clips[0].Speed = nil
				if strings.Join(buildTimelineRenderArgs([]string{"v.mp4"}, clips, map[string]int{"v": 0}, sources, "out.mp4"), " ") != graph {
					t.Fatal("1x regression")
				}
			}
		})
	}
}

func TestSpeedRenderMixedSourcesAndTimelineOverlays(t *testing.T) {
	clips := []editClip{{ID: "a", SourceID: "v", SourceEnd: 6, Speed: speedValue(2)}, {ID: "b", SourceID: "other", SourceStart: 2, SourceEnd: 4, Speed: speedValue(.5)}, {ID: "c", SourceID: "v", SourceStart: 4, SourceEnd: 7, Speed: speedValue(1.5)}}
	timeline := validTimeline(clips...)
	timeline.Overlays = []editorCoverOverlay{{ID: "cover", Mode: "cover", Start: 7, End: 9, X: 10, Y: 10, Width: 20, Height: 20}}
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	sources := map[string]sourceVideo{"v": {Duration: 10, HasAudio: true}, "other": {Duration: 10, HasAudio: true}}
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal(err)
	}
	segments := renderAudioSegments(clips, nil)
	if segments[1].TimelineStart != 3 || segments[2].TimelineStart != 7 {
		t.Fatal(segments)
	}
	graph := strings.Join(buildAnnotatedTimelineRenderArgs([]string{"v.mp4", "other.mp4"}, clips, map[string]int{"v": 0, "other": 1}, sources, "out.mp4", timeline.Overlays, []editorAnnotation{{ID: "arrow", Type: "arrow", Start: 7, End: 9, X: 10, Y: 10, Width: 20, Height: 10}}), " ")
	for _, want := range []string{"[v0][v1][v2]concat=n=3:v=1:a=0", "[1:a:0]atrim=start=2.000000000", "atrim=end_sample=432000", "between(t,7.000,9.000)", "between(t,7.000000,9.000000)"} {
		if !strings.Contains(graph, want) {
			t.Fatal(want, graph)
		}
	}
	timeline.Overlays[0].End = 9.1
	if validateEditTimeline(&timeline) == nil {
		t.Fatal("overlay past speed-adjusted end accepted")
	}
}

func TestSpeedRenderAudioCouplingAndGaps(t *testing.T) {
	clips := []editClip{{ID: "c", SourceID: "v", SourceEnd: 10, Speed: speedValue(2)}}
	s := editorAudioSegment{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 10, GeometryLinked: linkValue(true), Speed: speedValue(.5)}
	if rate, err := effectiveRenderAudioSpeed(s, clips); rate != 2 || err != nil {
		t.Fatal(rate, err)
	}
	linked := []editorAudioSegment{s}
	linkedGraph := strings.Join(timelineAudioFilters(clips, &linked, map[string]int{"v": 0}, map[string]sourceVideo{"v": {HasAudio: true}}), ";")
	if strings.Count(linkedGraph, "atempo=2.000000000") != 1 || strings.Contains(linkedGraph, "atempo=0.500000000") || !strings.Contains(linkedGraph, "atrim=end_sample=240000") {
		t.Fatal(linkedGraph)
	}
	for _, linked := range []*bool{nil, linkValue(false)} {
		s.GeometryLinked = linked
		if rate, err := effectiveRenderAudioSpeed(s, clips); rate != .5 || err != nil {
			t.Fatal(rate, err)
		}
	}
	s.GeometryLinked = linkValue(true)
	s.TimelineStart = 1
	if _, err := effectiveRenderAudioSpeed(s, clips); err == nil {
		t.Fatal("inconsistent linkage accepted")
	}
	s.TimelineStart = 0
	s.SourceClipID = "absent"
	if _, err := effectiveRenderAudioSpeed(s, clips); err == nil {
		t.Fatal("missing clip accepted")
	}
	// Two five-second segments separated by a two-second timeline gap.
	clips = []editClip{{ID: "c", SourceID: "v", SourceEnd: 12}}
	sources := map[string]sourceVideo{"v": {Duration: 20, HasAudio: true}}
	for _, speed := range []float64{.5, 1, 1.5, 2} {
		segments := []editorAudioSegment{{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 5 * speed, Speed: speedValue(speed), Volume: speedValue(.4)}, {ID: "b", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 5 * speed, Speed: speedValue(speed), TimelineStart: 7, Muted: true}}
		timeline := validTimeline(clips...)
		timeline.AudioSegments = &segments
		if err := validateRenderAudio(timeline, sources); err != nil {
			t.Fatal(err)
		}
		before := append([]editorAudioSegment{}, segments...)
		graph := strings.Join(timelineAudioFilters(clips, &segments, map[string]int{"v": 0}, sources), ";")
		for _, want := range []string{"volume=0.400000000,apad=whole_len=240000,atrim=end_sample=240000", "anullsrc=r=48000:cl=stereo,atrim=end_sample=96000", "anullsrc=r=48000:cl=stereo,atrim=end_sample=240000", "atrim=end_sample=576000"} {
			if !strings.Contains(graph, want) {
				t.Fatal(want, graph)
			}
		}
		if strings.Count(graph, ":a:0]") != 1 || strings.Contains(graph, "atempo=4.") {
			t.Fatal(graph)
		}
		if speed != 1 && !strings.Contains(graph, fmt.Sprintf("channel_layouts=stereo,atempo=%.9f,volume=", speed)) {
			t.Fatal(graph)
		}
		if !reflect.DeepEqual(segments, before) {
			t.Fatal("persisted data mutated")
		}
		segments[1].TimelineStart = 6.9
		if validateRenderAudio(timeline, sources) != nil {
			t.Fatal("valid gap rejected")
		}
		segments[1].TimelineStart = 4.9
		if validateRenderAudio(timeline, sources) == nil {
			t.Fatal("overlap accepted")
		}
		segments[1].TimelineStart = 7.1
		if validateRenderAudio(timeline, sources) == nil {
			t.Fatal("overflow accepted")
		}
	}
}

func TestSpeedRenderEndpointQueuesValidSpeeds(t *testing.T) {
	for _, geometry := range []string{"true", "false", "null"} {
		t.Run(geometry, func(t *testing.T) {
			mock, err := pgxmock.NewPool()
			if err != nil {
				t.Fatal(err)
			}
			defer mock.Close()
			handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
			mock.ExpectQuery(`SELECT user_id, organization_id, title FROM videos`).WithArgs("v", testUserID).WillReturnRows(pgxmock.NewRows([]string{"user_id", "organization_id", "title"}).AddRow(testUserID, nil, "Speed"))
			mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).WithArgs("v", testUserID).WillReturnRows(pgxmock.NewRows([]string{"file_key", "content_type", "duration"}).AddRow("v.mp4", "video/mp4", 20))
			mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, edit_render_status = 'processing'`).WithArgs(pgxmock.AnyArg(), "v", testUserID).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
			previous := enqueueTimelineRender
			defer func() { enqueueTimelineRender = previous }()
			var queued renderJob
			enqueueTimelineRender = func(_ *Handler, job renderJob) { queued = job }
			body := `{"version":1,"clips":[{"id":"c","sourceId":"v","sourceStart":0,"sourceEnd":10,"speed":2}],"audioSegments":[{"id":"a","sourceClipId":"c","sourceVideoId":"v","sourceStart":0,"sourceEnd":10,"timelineStart":0,"geometryLinked":` + geometry + `,"speed":2}]}`
			router := chi.NewRouter()
			router.With(newAuthMiddleware()).Post("/api/videos/{id}/editor/render", handler.RenderEditorTimeline)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, authenticatedRequest(t, http.MethodPost, "/api/videos/v/editor/render", []byte(body)))
			if response.Code != http.StatusAccepted || len(queued.Timeline.Clips) != 1 || queued.Timeline.Clips[0].Duration != 5 {
				t.Fatal(response.Code, response.Body.String(), queued.Timeline)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Real output timing check, runnable on a host with FFmpeg; never requires Docker.
func TestSpeedRenderFFmpegIntegration(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "source.mkv")
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("ffmpeg", append([]string{"-v", "error"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	run("-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-c:v", "libx264", "-c:a", "pcm_s16le", "-y", input)
	for _, speed := range []float64{.5, .75, 1, 1.25, 1.5, 2} {
		t.Run(fmt.Sprint(speed), func(t *testing.T) {
			clips := []editClip{{ID: "a", SourceID: "v", SourceStart: .2, SourceEnd: 3.2, Speed: speedValue(speed)}}
			output := filepath.Join(dir, fmt.Sprintf("speed-%g.mp4", speed))
			run(buildTimelineRenderArgs([]string{input}, clips, map[string]int{"v": 0}, map[string]sourceVideo{"v": {HasAudio: true}}, output)...)
			data, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", output).Output()
			if err != nil {
				t.Fatal(err)
			}
			var probe struct {
				Streams []struct {
					Type     string `json:"codec_type"`
					Duration string `json:"duration"`
				}
			}
			if err := json.Unmarshal(data, &probe); err != nil {
				t.Fatal(err)
			}
			if len(probe.Streams) != 2 {
				t.Fatal(string(data))
			}
			var video, audio float64
			for _, stream := range probe.Streams {
				d, err := strconv.ParseFloat(stream.Duration, 64)
				if err != nil {
					t.Fatal(err)
				}
				if stream.Type == "video" {
					video = d
				} else {
					audio = d
				}
			}
			if math.Abs(video-3/speed) > 1.0/30+.002 || math.Abs(audio-3/speed) > .025 || math.Abs(video-audio) > 1.0/30+.002 {
				t.Fatal(video, audio, 3/speed)
			}
			// Pitch stays at 440 Hz rather than following playback speed.
			pcm, err := exec.Command("ffmpeg", "-v", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1").Output()
			if err != nil || len(pcm) < 48000 {
				t.Fatal("missing decoded audio", err)
			}
			crossings := 0
			var previous int16
			for i := 12000; i < 24000; i++ {
				sample := int16(binary.LittleEndian.Uint16(pcm[i*2:]))
				if i > 12000 && previous <= 0 && sample > 0 {
					crossings++
				}
				previous = sample
			}
			if math.Abs(float64(crossings)*4-440) > 20 {
				t.Fatal("pitch changed", crossings*4)
			}
		})
	}
}
