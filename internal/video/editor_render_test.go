package video

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pashagolub/pgxmock/v4"
)

func validTimeline(clips ...editClip) editTimeline {
	return editTimeline{Version: 1, Clips: clips}
}

func TestValidateEditTimeline(t *testing.T) {
	tests := []struct {
		name     string
		timeline editTimeline
		wantErr  bool
	}{
		{"one clip", validTimeline(editClip{ID: "one", SourceID: "source-a", SourceStart: 2, SourceEnd: 5}), false},
		{"same source", validTimeline(
			editClip{ID: "one", SourceID: "source-a", SourceStart: 0, SourceEnd: 2},
			editClip{ID: "two", SourceID: "source-a", SourceStart: 7, SourceEnd: 9}), false},
		{"two sources", validTimeline(
			editClip{ID: "one", SourceID: "source-a", SourceStart: 0, SourceEnd: 2},
			editClip{ID: "two", SourceID: "source-b", SourceStart: 1, SourceEnd: 4}), false},
		{"empty", validTimeline(), true},
		{"invalid range", validTimeline(editClip{ID: "one", SourceID: "source-a", SourceStart: 4, SourceEnd: 4}), true},
		{"duplicate id", validTimeline(
			editClip{ID: "same", SourceID: "source-a", SourceStart: 0, SourceEnd: 2},
			editClip{ID: "same", SourceID: "source-b", SourceStart: 0, SourceEnd: 2}), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEditTimeline(&tt.timeline)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateEditTimeline() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil {
				for _, clip := range tt.timeline.Clips {
					if clip.Duration != clip.SourceEnd-clip.SourceStart {
						t.Fatalf("duration was not derived from source range: %+v", clip)
					}
				}
			}
		})
	}
}

func TestValidateAndPersistArrowAnnotations(t *testing.T) {
	timeline := validTimeline(editClip{ID: "one", SourceID: "source", SourceEnd: 10})
	timeline.Annotations = []editorAnnotation{{ID: "arrow-1", Type: "arrow", X: 20, Y: 30, Width: 40, Height: 20, Start: 1, End: 5, Rotation: 315}}
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(timeline)
	if err != nil {
		t.Fatal(err)
	}
	var restored editTimeline
	if err := json.Unmarshal(encoded, &restored); err != nil || len(restored.Annotations) != 1 || restored.Annotations[0] != timeline.Annotations[0] {
		t.Fatalf("annotation did not survive timeline JSON roundtrip: %s, %v", encoded, err)
	}
	for _, invalid := range []editorAnnotation{
		{ID: "arrow", Type: "circle", Width: 10, Height: 10, End: 5},
		{ID: "arrow", Type: "arrow", X: 95, Width: 10, Height: 10, End: 5},
		{ID: "arrow", Type: "arrow", Width: 10, Height: 10, End: 20},
		{ID: "arrow", Type: "arrow", Width: 10, Height: 10, End: 5, Rotation: math.Inf(1)},
		{ID: "arrow", Type: "arrow", Width: 10, Height: 10, End: 5, Rotation: math.NaN()},
	} {
		timeline.Annotations = []editorAnnotation{invalid}
		if validateEditTimeline(&timeline) == nil {
			t.Fatalf("accepted invalid annotation: %+v", invalid)
		}
	}
	timeline.Annotations = append(restored.Annotations, restored.Annotations[0])
	if validateEditTimeline(&timeline) == nil {
		t.Fatal("accepted duplicate annotation ids")
	}
}

func TestValidateAnnotationColor(t *testing.T) {
	for _, color := range []string{"", "#FC2667", "#123abc", "#000000", "#FFFFFF"} {
		timeline := validTimeline(editClip{ID: "one", SourceID: "source", SourceEnd: 10})
		timeline.Annotations = []editorAnnotation{{ID: "arrow", Type: "arrow", Width: 20, Height: 20, End: 5, Rotation: 37, Color: color}}
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatalf("color %q: %v", color, err)
		}
		encoded, err := json.Marshal(timeline)
		if err != nil {
			t.Fatal(err)
		}
		var restored editTimeline
		if err := json.Unmarshal(encoded, &restored); err != nil || restored.Annotations[0] != timeline.Annotations[0] {
			t.Fatalf("color did not survive persistence: %s, %v", encoded, err)
		}
	}
	for _, color := range []string{"#fff", "#12345678", "red", "123456", "#gggggg", " #123456", "#123456;movie=x"} {
		timeline := validTimeline(editClip{ID: "one", SourceID: "source", SourceEnd: 10})
		timeline.Annotations = []editorAnnotation{{ID: "arrow", Type: "arrow", Width: 20, Height: 20, End: 5, Color: color}}
		if validateEditTimeline(&timeline) == nil {
			t.Fatalf("accepted invalid color %q", color)
		}
	}
}

func TestValidateAnnotationFreeRotation(t *testing.T) {
	for _, angle := range []float64{0, 45, 315, 37, 37.123, 359.999, -323, 397} {
		timeline := validTimeline(editClip{ID: "one", SourceID: "source", SourceEnd: 10})
		timeline.Annotations = []editorAnnotation{{ID: "arrow", Type: "arrow", Width: 20, Height: 20, End: 5, Rotation: angle}}
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatal(err)
		}
		want := angle
		if angle < 0 || angle >= 360 {
			want = math.Mod(math.Mod(angle, 360)+360, 360)
		}
		if timeline.Annotations[0].Rotation != want {
			t.Fatalf("rotation %f normalized incorrectly", angle)
		}
		encoded, err := json.Marshal(timeline)
		if err != nil {
			t.Fatal(err)
		}
		var restored editTimeline
		if err := json.Unmarshal(encoded, &restored); err != nil || restored.Annotations[0].Rotation != want {
			t.Fatalf("rotation did not survive persistence: %s, %v", encoded, err)
		}
	}
}

func TestValidateEditTimelineNormalizesAndValidatesOverlayMode(t *testing.T) {
	legacy := validTimeline(editClip{ID: "one", SourceID: "source-a", SourceStart: 0, SourceEnd: 10})
	legacy.Overlays = []editorCoverOverlay{{
		ID: "legacy", X: 10, Y: 10, Width: 20, Height: 20, Start: 0, End: 5,
	}}
	if err := validateEditTimeline(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.Overlays[0].Mode != "cover" {
		t.Fatalf("legacy overlay mode = %q, want cover", legacy.Overlays[0].Mode)
	}

	blur := validTimeline(editClip{ID: "one", SourceID: "source-a", SourceStart: 0, SourceEnd: 10})
	blur.Overlays = []editorCoverOverlay{{
		ID: "blur", X: 10, Y: 10, Width: 20, Height: 20, Start: 0, End: 5, Mode: "blur",
	}}
	if err := validateEditTimeline(&blur); err != nil {
		t.Fatalf("blur overlay rejected: %v", err)
	}

	invalid := blur
	invalid.Overlays = append([]editorCoverOverlay(nil), blur.Overlays...)
	invalid.Overlays[0].Mode = "pixelate"
	if err := validateEditTimeline(&invalid); err == nil {
		t.Fatal("invalid overlay mode was accepted")
	}

	blur.Overlays[0].Color = "#e6467a"
	if err := validateEditTimeline(&blur); err != nil {
		t.Fatalf("valid cover color rejected: %v", err)
	}
	blur.Overlays[0].Color = "red;drawbox"
	if err := validateEditTimeline(&blur); err == nil {
		t.Fatal("invalid cover color was accepted")
	}

	opacity := 0.5
	blur.Overlays[0].Color = ""
	blur.Overlays[0].Opacity = &opacity
	if err := validateEditTimeline(&blur); err != nil {
		t.Fatalf("valid cover opacity rejected: %v", err)
	}
	opacity = 0
	if err := validateEditTimeline(&blur); err == nil {
		t.Fatal("invalid cover opacity was accepted")
	}
}

func TestBuildTimelineRenderArgsPreservesClipOrderAndRanges(t *testing.T) {
	clips := []editClip{
		{ID: "first", SourceID: "original", SourceStart: 4.2, SourceEnd: 11.8, Duration: 7.6},
		{ID: "second", SourceID: "inserted", SourceStart: 18.1, SourceEnd: 27.4, Duration: 9.3},
		{ID: "third", SourceID: "original", SourceStart: 30, SourceEnd: 35, Duration: 5},
	}
	sources := map[string]sourceVideo{
		"original": {ID: "original", HasAudio: true},
		"inserted": {ID: "inserted", HasAudio: true},
	}
	args := buildTimelineRenderArgs(
		[]string{"original.mp4", "inserted.webm"}, clips,
		map[string]int{"original": 0, "inserted": 1}, sources, "output.mp4",
	)
	joined := strings.Join(args, " ")
	ordered := []string{
		"[0:v]trim=start=4.200:end=11.800",
		"[1:v]trim=start=18.100:end=27.400",
		"[0:v]trim=start=30.000:end=35.000",
		"[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1",
	}
	position := -1
	for _, fragment := range ordered {
		next := strings.Index(joined, fragment)
		if next <= position {
			t.Fatalf("fragment %q missing or out of order in %s", fragment, joined)
		}
		position = next
	}
	if !strings.Contains(joined, "force_original_aspect_ratio=decrease") ||
		!strings.Contains(joined, "pad=1920:1080") {
		t.Fatalf("render args must preserve aspect ratio and pad to the target frame: %s", joined)
	}

	silentSources := map[string]sourceVideo{"silent": {ID: "silent", HasAudio: false}}
	silentArgs := strings.Join(buildTimelineRenderArgs(
		[]string{"silent.mp4"},
		[]editClip{{ID: "silent", SourceID: "silent", SourceStart: 1, SourceEnd: 3.5, Duration: 2.5}},
		map[string]int{"silent": 0}, silentSources, "silent-output.mp4",
	), " ")
	if !strings.Contains(silentArgs, "anullsrc=r=48000:cl=stereo,atrim=duration=2.500") {
		t.Fatalf("silent audio must exactly match the clip duration: %s", silentArgs)
	}
}

func TestBuildTimelineRenderArgsIncludesTimedCoverOverlay(t *testing.T) {
	clips := []editClip{
		{ID: "clip-1", SourceID: "original", SourceStart: 0, SourceEnd: 12, Duration: 12},
	}
	sources := map[string]sourceVideo{
		"original": {ID: "original", HasAudio: true},
	}
	overlays := []editorCoverOverlay{
		{
			ID:     "cover-1",
			X:      25,
			Y:      10,
			Width:  40,
			Height: 20,
			Start:  3.5,
			End:    8.25,
		},
	}

	args := buildTimelineRenderArgs(
		[]string{"original.mp4"},
		clips,
		map[string]int{"original": 0},
		sources,
		"output.mp4",
		overlays,
	)

	joined := strings.Join(args, " ")

	expected := "drawbox=x=iw*0.250000:y=ih*0.100000:w=iw*0.400000:h=ih*0.200000:color=black:t=fill:enable='between(t,3.500,8.250)'"
	if !strings.Contains(joined, expected) {
		t.Fatalf("render args missing timed cover overlay; expected %q in %s", expected, joined)
	}
}

func TestBuildTimelineRenderArgsUsesCustomCoverColor(t *testing.T) {
	clips := []editClip{{ID: "clip-1", SourceID: "original", SourceStart: 0, SourceEnd: 12, Duration: 12}}
	sources := map[string]sourceVideo{"original": {ID: "original", HasAudio: true}}
	overlays := []editorCoverOverlay{
		{ID: "cover", X: 25, Y: 10, Width: 40, Height: 20, Start: 3.5, End: 8.25, Mode: "cover", Color: "#e6467a"},
	}

	joined := strings.Join(buildTimelineRenderArgs(
		[]string{"original.mp4"}, clips, map[string]int{"original": 0}, sources, "output.mp4", overlays,
	), " ")
	expected := "drawbox=x=iw*0.250000:y=ih*0.100000:w=iw*0.400000:h=ih*0.200000:color=0xe6467a:t=fill:enable='between(t,3.500,8.250)'"
	if !strings.Contains(joined, expected) {
		t.Fatalf("render args missing custom cover color; expected %q in %s", expected, joined)
	}
}

func TestBuildTimelineRenderArgsUsesCoverOpacity(t *testing.T) {
	clips := []editClip{{ID: "clip-1", SourceID: "original", SourceStart: 0, SourceEnd: 12, Duration: 12}}
	sources := map[string]sourceVideo{"original": {ID: "original", HasAudio: true}}
	opacity := 0.5
	overlays := []editorCoverOverlay{
		{ID: "cover", X: 25, Y: 10, Width: 40, Height: 20, Start: 3.5, End: 8.25, Mode: "cover", Color: "#e6467a", Opacity: &opacity},
	}

	joined := strings.Join(buildTimelineRenderArgs(
		[]string{"original.mp4"}, clips, map[string]int{"original": 0}, sources, "output.mp4", overlays,
	), " ")
	want := []string{
		"color=c=black@0.0:s=1920x1080:r=30:d=12.000,format=rgba",
		"drawbox=x=iw*0.250000:y=ih*0.100000:w=iw*0.400000:h=ih*0.200000:color=0xe6467a@0.500:t=fill:replace=1",
		"overlay=x=0:y=0:enable='between(t,3.500,8.250)'",
	}
	for _, expected := range want {
		if !strings.Contains(joined, expected) {
			t.Fatalf("render args missing cover opacity fragment %q in %s", expected, joined)
		}
	}
}

func TestBuildTimelineRenderArgsIncludesTimedScaledBlurOverlays(t *testing.T) {
	clips := []editClip{{ID: "clip-1", SourceID: "original", SourceStart: 0, SourceEnd: 12, Duration: 12}}
	sources := map[string]sourceVideo{"original": {ID: "original", HasAudio: true}}
	overlays := []editorCoverOverlay{
		{ID: "blur-1", X: 25, Y: 10, Width: 40, Height: 20, Start: 3.5, End: 8.25, Mode: "blur"},
		{ID: "blur-2", X: 5, Y: 60, Width: 15, Height: 25, Start: 1, End: 11, Mode: "blur"},
	}

	joined := strings.Join(buildTimelineRenderArgs(
		[]string{"original.mp4"}, clips, map[string]int{"original": 0}, sources, "output.mp4", overlays,
	), " ")
	want := []string{
		"crop=w=iw*0.400000:h=ih*0.200000:x=iw*0.250000:y=ih*0.100000,gblur=sigma=12:steps=2",
		"overlay=x=main_w*0.250000:y=main_h*0.100000:enable='between(t,3.500,8.250)'",
		"crop=w=iw*0.150000:h=ih*0.250000:x=iw*0.050000:y=ih*0.600000,gblur=sigma=12:steps=2",
		"overlay=x=main_w*0.050000:y=main_h*0.600000:enable='between(t,1.000,11.000)'",
	}
	for _, fragment := range want {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("render args missing blur fragment %q in %s", fragment, joined)
		}
	}
}

func TestBuildTimelineRenderArgsAppliesCoverAfterBlur(t *testing.T) {
	clips := []editClip{{ID: "clip-1", SourceID: "original", SourceStart: 0, SourceEnd: 12, Duration: 12}}
	sources := map[string]sourceVideo{"original": {ID: "original", HasAudio: true}}
	overlays := []editorCoverOverlay{
		{ID: "legacy-cover", X: 10, Y: 10, Width: 40, Height: 40, Start: 0, End: 10},
		{ID: "blur", X: 10, Y: 10, Width: 40, Height: 40, Start: 0, End: 10, Mode: "blur", Color: "#ff0000"},
		{ID: "cover", X: 20, Y: 20, Width: 20, Height: 20, Start: 2, End: 8, Mode: "cover"},
	}

	joined := strings.Join(buildTimelineRenderArgs(
		[]string{"original.mp4"}, clips, map[string]int{"original": 0}, sources, "output.mp4", overlays,
	), " ")
	blurPosition := strings.Index(joined, "gblur=sigma=12:steps=2")
	legacyCoverPosition := strings.Index(joined, "drawbox=x=iw*0.100000:y=ih*0.100000")
	explicitCoverPosition := strings.Index(joined, "drawbox=x=iw*0.200000:y=ih*0.200000")
	if blurPosition < 0 || legacyCoverPosition <= blurPosition || explicitCoverPosition <= legacyCoverPosition {
		t.Fatalf("blur must render before legacy and explicit covers: %s", joined)
	}
	if strings.Contains(joined, "color=0xff0000") {
		t.Fatalf("blur overlay color must not be applied: %s", joined)
	}
}

func TestBuildTimelineRenderArgsCoverText(t *testing.T) {
	opacity := 0.4
	overlays := []editorCoverOverlay{
		{ID: "legacy", X: 25, Y: 10, Width: 40, Height: 20, Start: 1, End: 2, Text: "Grüße: ' \\ % , (ß)"},
		{ID: "blur", Width: 40, Height: 20, End: 3, Mode: "blur", Text: "NEVER RENDER"},
		{ID: "alpha", Width: 20, Height: 20, Start: 2, End: 3, Mode: "cover", Color: "#ff8000", Opacity: &opacity, Text: "Second"},
		{ID: "tiny", Width: 1, Height: 1, End: 3, Text: "Too small"},
	}
	build := func(items []editorCoverOverlay) string {
		return strings.Join(buildTimelineRenderArgs([]string{"input.mp4"},
			[]editClip{{SourceID: "source", SourceEnd: 3, Duration: 3}},
			map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, "out.mp4", items), " ")
	}
	graph := build(overlays)
	for _, want := range []string{
		"color=c=black@0.0:s=760x208:r=30:d=3.000,format=rgba,drawtext=",
		"fontfile=" + editorTextFont + ":textfile=cover-text-0.txt:expansion=none:fontcolor=white:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2",
		"overlay=x=484:y=112:enable='between(t,1.000,2.000)'",
		"textfile=cover-text-2.txt:expansion=none:fontcolor=white",
		"overlay=x=4:y=4:enable='between(t,2.000,3.000)'[vout]",
	} {
		if !strings.Contains(graph, want) {
			t.Fatalf("missing %q in %s", want, graph)
		}
	}
	if strings.Count(graph, "drawtext=") != 2 || strings.Index(graph, "drawtext=") < strings.LastIndex(graph, "drawbox=") {
		t.Fatalf("exactly two text surfaces must follow all cover fills: %s", graph)
	}
	for _, overlay := range overlays {
		if strings.Contains(graph, overlay.Text) {
			t.Fatalf("user text must never enter filtergraph: %q", overlay.Text)
		}
	}
	// Empty text and stored blur text must retain the original no-text path.
	without := append([]editorCoverOverlay(nil), overlays...)
	for i := range without {
		without[i].Text = ""
	}
	want := build(without)
	without[1].Text = "ignored blur text"
	if build(without) != want || strings.Contains(want, "drawtext=") || !strings.Contains(want, "color=black:t=fill") {
		t.Fatal("no-text/legacy cover or blur render path changed")
	}
}

func TestPrepareCoverTextFiles(t *testing.T) {
	dir := t.TempDir()
	text := "Grüße: ' \\ % , (ÄÖÜ äöü ß) %{pts};[vout]"
	overlays := []editorCoverOverlay{
		{ID: "../../untrusted", Width: 80, Height: 50, Text: text},
		{Mode: "blur", Width: 80, Height: 50, Text: text},
		{Width: 80, Height: 50},
		{Width: 1, Height: 1, Text: text},
	}
	if err := prepareCoverTextFiles(dir, overlays); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 || files[0].Name() != "cover-text-0.txt" {
		t.Fatalf("unexpected text sidecars: %v, %v", files, err)
	}
	content, err := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if err != nil || string(content) != text {
		t.Fatalf("UTF-8 literal text changed: %q, %v", content, err)
	}
	info, err := files[0].Info()
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("text file must be private")
	}
	if err := prepareCoverTextFiles(filepath.Join(dir, "missing"), overlays); err == nil {
		t.Fatal("sidecar write error must be propagated")
	}
}

func TestCoverTextBounds(t *testing.T) {
	for _, size := range []struct {
		width, height float64
		visible       bool
	}{
		{40, 20, true}, {2, 4, true}, {1, 20, false}, {40, 1, false},
	} {
		overlay := editorCoverOverlay{X: 10.11, Y: 20.11, Width: size.width, Height: size.height, Text: "Text"}
		x, y, width, height, visible := coverTextBounds(overlay)
		if visible != size.visible {
			t.Fatalf("size %+v: visible=%v", size, visible)
		}
		if visible && (float64(x) < 1920*overlay.X/100 || float64(y) < 1080*overlay.Y/100 ||
			float64(x+width) > 1920*(overlay.X+overlay.Width)/100 || float64(y+height) > 1080*(overlay.Y+overlay.Height)/100) {
			t.Fatal("text surface escapes cover bounds")
		}
	}
}

func TestRenderEditorTimelineSavesTimelineAndQueuesResolvedSources(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)

	mock.ExpectQuery(`SELECT user_id, organization_id, title FROM videos`).
		WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"user_id", "organization_id", "title"}).
			AddRow(testUserID, nil, "Original"))
	mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).
		WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"file_key", "content_type", "duration"}).
			AddRow("recordings/main.mp4", "video/mp4", 20))
	mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).
		WithArgs("video-inserted", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"file_key", "content_type", "duration"}).
			AddRow("recordings/inserted.webm", "video/webm", 30))
	mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, edit_render_status = 'processing'`).
		WithArgs(pgxmock.AnyArg(), "video-main", testUserID).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))

	originalEnqueue := enqueueTimelineRender
	defer func() { enqueueTimelineRender = originalEnqueue }()
	var queued renderJob
	enqueueTimelineRender = func(_ *Handler, job renderJob) { queued = job }

	body := `{"version":1,"clips":[` +
		`{"id":"a","sourceId":"video-main","sourceStart":2,"sourceEnd":5,"duration":999},` +
		`{"id":"b","sourceId":"video-inserted","sourceStart":7,"sourceEnd":11,"duration":999},` +
		`{"id":"c","sourceId":"video-main","sourceStart":12,"sourceEnd":14,"duration":999}]}`
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Post("/api/videos/{id}/editor/render", handler.RenderEditorTimeline)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authenticatedRequest(t, http.MethodPost, "/api/videos/video-main/editor/render", []byte(body)))

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(queued.Timeline.Clips) != 3 || queued.Timeline.Clips[1].SourceID != "video-inserted" {
		t.Fatalf("queued timeline order changed: %+v", queued.Timeline.Clips)
	}
	if queued.Timeline.Clips[0].Duration != 3 || queued.Timeline.Clips[1].Duration != 4 {
		t.Fatalf("server did not derive clip durations: %+v", queued.Timeline.Clips)
	}
	if len(queued.Sources) != 2 {
		t.Fatalf("expected two unique resolved sources, got %d", len(queued.Sources))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRenderEditorTimelineRejectsUnavailableSource(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)

	mock.ExpectQuery(`SELECT user_id, organization_id, title FROM videos`).
		WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"user_id", "organization_id", "title"}).
			AddRow(testUserID, nil, "Original"))
	mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).
		WithArgs("missing-source", testUserID).
		WillReturnError(fmt.Errorf("not found"))

	originalEnqueue := enqueueTimelineRender
	defer func() { enqueueTimelineRender = originalEnqueue }()
	enqueued := false
	enqueueTimelineRender = func(_ *Handler, _ renderJob) { enqueued = true }

	body := `{"version":1,"clips":[{"id":"a","sourceId":"missing-source","sourceStart":0,"sourceEnd":2}]}`
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Post("/api/videos/{id}/editor/render", handler.RenderEditorTimeline)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authenticatedRequest(t, http.MethodPost, "/api/videos/video-main/editor/render", []byte(body)))

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if enqueued {
		t.Fatal("render must not be queued for an unavailable source")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRenderEditorTimelineRejectsConcurrentRender(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)

	mock.ExpectQuery(`SELECT user_id, organization_id, title FROM videos`).
		WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"user_id", "organization_id", "title"}).
			AddRow(testUserID, nil, "Original"))
	mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).
		WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"file_key", "content_type", "duration"}).
			AddRow("recordings/main.mp4", "video/mp4", 20))
	mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, edit_render_status = 'processing'`).
		WithArgs(pgxmock.AnyArg(), "video-main", testUserID).
		WillReturnResult(pgxmock.NewResult("UPDATE", 0))

	originalEnqueue := enqueueTimelineRender
	defer func() { enqueueTimelineRender = originalEnqueue }()
	enqueued := false
	enqueueTimelineRender = func(_ *Handler, _ renderJob) { enqueued = true }

	body := `{"version":1,"clips":[{"id":"a","sourceId":"video-main","sourceStart":0,"sourceEnd":2}]}`
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Post("/api/videos/{id}/editor/render", handler.RenderEditorTimeline)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authenticatedRequest(t, http.MethodPost, "/api/videos/video-main/editor/render", []byte(body)))

	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if enqueued {
		t.Fatal("a concurrent render must not enqueue another job")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGetEditorStateReturnsStoredTimeline(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
	raw := `{"version":1,"clips":[{"id":"saved","sourceId":"source-a","sourceStart":3,"sourceEnd":8,"duration":5}]}`
	renderedID := "rendered-id"
	mock.ExpectQuery(`SELECT COALESCE\(edit_timeline`).WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"edit_timeline", "edit_render_status", "edit_render_error", "edit_render_video_id"}).
			AddRow([]byte(raw), "ready", (*string)(nil), &renderedID))

	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Get("/api/videos/{id}/editor", handler.GetEditorState)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authenticatedRequest(t, http.MethodGet, "/api/videos/video-main/editor", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; expectations: %v", recorder.Code, mock.ExpectationsWereMet())
	}
	var state editorStateResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Timeline.Clips) != 1 || state.Timeline.Clips[0].SourceStart != 3 || state.RenderedVideo == nil {
		t.Fatalf("unexpected restored state: %+v", state)
	}
}

func TestSaveEditorTimelinePersistsOverlaysWithoutStartingRender(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)

	mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, updated_at = now\(\)`).
		WithArgs(pgxmock.AnyArg(), "video-main", testUserID).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))

	body := `{"version":1,"clips":[{"id":"a","sourceId":"video-main","sourceStart":0,"sourceEnd":20}],` +
		`"overlays":[{"id":"cover-1","x":10,"y":20,"width":30,"height":40,"start":2,"end":8,"mode":"blur"}]}`
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Put("/api/videos/{id}/editor", handler.SaveEditorTimeline)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authenticatedRequest(t, http.MethodPut, "/api/videos/video-main/editor", []byte(body)))

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestRenderTimelineFailureOnlyMarksEditFailed(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	storage := &mockStorage{downloadToFileErr: fmt.Errorf("source unavailable")}
	handler := NewHandler(mock, storage, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
	mock.ExpectExec(`UPDATE videos SET edit_render_status = 'failed'`).
		WithArgs("source unavailable", "original-id").
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	handler.renderTimelineAsync(context.Background(), renderJob{
		SourceVideoID: "original-id",
		Timeline:      validTimeline(editClip{ID: "one", SourceID: "original-id", SourceStart: 0, SourceEnd: 2, Duration: 2}),
		Sources:       map[string]sourceVideo{"original-id": {ID: "original-id", FileKey: "original.mp4", ContentType: "video/mp4", Duration: 10}},
	})
	if storage.uploadFileCallCount != 0 || storage.deleteCallCount != 0 {
		t.Fatal("failed render must not upload or delete an original object")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTimelineRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").CombinedOutput(); err != nil || !strings.Contains(string(out), "libx264") {
		t.Skip("ffmpeg libx264 encoder not available")
	}
	dir := t.TempDir()
	inputs := []string{filepath.Join(dir, "original-a.mp4"), filepath.Join(dir, "video-b.mp4")}
	colors := []string{"red", "blue"}
	frequencies := []string{"440", "880"}
	sampleRates := []string{"44100", "48000"}
	channels := []string{"1", "2"}
	for i := range inputs {
		cmd := exec.Command("ffmpeg", "-f", "lavfi", "-i", "color=c="+colors[i]+":s=320x180:d=2",
			"-f", "lavfi", "-i", "sine=frequency="+frequencies[i]+":sample_rate="+sampleRates[i]+":duration=2",
			"-ac", channels[i], "-c:v", "libx264", "-c:a", "aac", "-shortest", "-y", inputs[i])
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("create fixture: %v: %s", err, output)
		}
	}
	output := filepath.Join(dir, "result.mp4")
	clips := []editClip{
		{ID: "a-first", SourceID: "original-a", SourceStart: .25, SourceEnd: .75, Duration: .5},
		{ID: "b", SourceID: "video-b", SourceStart: .5, SourceEnd: 1, Duration: .5},
		{ID: "a-last", SourceID: "original-a", SourceStart: 1.25, SourceEnd: 1.75, Duration: .5},
	}
	sources := map[string]sourceVideo{
		"original-a": {ID: "original-a", HasAudio: true},
		"video-b":    {ID: "video-b", HasAudio: true},
	}
	cmd := exec.Command("ffmpeg", buildTimelineRenderArgs(inputs, clips, map[string]int{"original-a": 0, "video-b": 1}, sources, output)...)
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render: %v: %s", err, combined)
	}
	if info, err := os.Stat(output); err != nil || info.Size() == 0 {
		t.Fatalf("render output missing or empty: %v", err)
	}

	var probe struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Duration  string `json:"duration"`
		} `json:"streams"`
	}
	probeCmd := exec.Command("ffprobe", "-v", "error", "-show_entries",
		"stream=codec_type,width,height,duration", "-of", "json", output)
	probeOutput, err := probeCmd.Output()
	if err != nil {
		t.Fatalf("ffprobe failed: %v", err)
	}
	if err := json.Unmarshal(probeOutput, &probe); err != nil {
		t.Fatalf("decode ffprobe output: %v: %s", err, probeOutput)
	}
	if len(probe.Streams) != 2 {
		t.Fatalf("expected video and audio streams, got %+v", probe.Streams)
	}
	var videoDuration, audioDuration float64
	for _, stream := range probe.Streams {
		d, _ := strconv.ParseFloat(stream.Duration, 64)
		switch stream.CodecType {
		case "video":
			if stream.Width != 1920 || stream.Height != 1080 {
				t.Fatalf("unexpected output dimensions: %dx%d", stream.Width, stream.Height)
			}
			videoDuration = d
		case "audio":
			audioDuration = d
		}
	}
	if math.Abs(videoDuration-1.5) > .08 || math.Abs(audioDuration-1.5) > .08 {
		t.Fatalf("unexpected stream durations: video=%f audio=%f", videoDuration, audioDuration)
	}
	if math.Abs(videoDuration-audioDuration) > .05 {
		t.Fatalf("audio/video drift detected: video=%f audio=%f", videoDuration, audioDuration)
	}

	assertDominantColor := func(at string, channel int) {
		t.Helper()
		pixelCmd := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output,
			"-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
		pixel, err := pixelCmd.Output()
		if err != nil || len(pixel) < 3 {
			t.Fatalf("sample frame at %s: %v (%v)", at, err, pixel)
		}
		other := 2
		if channel == 2 {
			other = 0
		}
		if int(pixel[channel])-int(pixel[other]) < 80 {
			t.Fatalf("unexpected color at %s: rgb=%v", at, pixel[:3])
		}
	}
	assertDominantColor("0.25", 0)
	assertDominantColor("0.75", 2)
	assertDominantColor("1.25", 0)
}

func TestTimelineBlurRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").CombinedOutput(); err != nil || !strings.Contains(string(out), "libx264") {
		t.Skip("ffmpeg libx264 encoder not available")
	}

	dir := t.TempDir()
	input := filepath.Join(dir, "pattern.mp4")
	fixture := exec.Command("ffmpeg", "-f", "lavfi", "-i",
		"nullsrc=s=320x180:d=2,geq=lum='mod(floor(X/8)+floor(Y/8),2)*255':cb=128:cr=128",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Fatalf("create blur fixture: %v: %s", err, output)
	}

	output := filepath.Join(dir, "blurred.mp4")
	clips := []editClip{{ID: "clip", SourceID: "pattern", SourceStart: 0, SourceEnd: 2, Duration: 2}}
	sources := map[string]sourceVideo{"pattern": {ID: "pattern", HasAudio: false}}
	overlays := []editorCoverOverlay{
		{ID: "blur", X: 10, Y: 10, Width: 80, Height: 80, Start: .5, End: 1.5, Mode: "blur"},
		{ID: "cover", X: 45, Y: 45, Width: 10, Height: 10, Start: .5, End: 1.5, Mode: "cover"},
	}
	cmd := exec.Command("ffmpeg", buildTimelineRenderArgs(
		[]string{input}, clips, map[string]int{"pattern": 0}, sources, output, overlays,
	)...)
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render blur fixture: %v: %s", err, combined)
	}

	readBlurSample := func(at string) []byte {
		t.Helper()
		sample := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output,
			"-vf", "crop=384:216:384:216,scale=64:36", "-frames:v", "1",
			"-f", "rawvideo", "-pix_fmt", "gray", "pipe:1")
		pixels, err := sample.Output()
		if err != nil || len(pixels) == 0 {
			t.Fatalf("sample blur frame at %s: %v", at, err)
		}
		return pixels
	}
	variance := func(pixels []byte) float64 {
		var sum, sumSquares float64
		for _, pixel := range pixels {
			value := float64(pixel)
			sum += value
			sumSquares += value * value
		}
		mean := sum / float64(len(pixels))
		return sumSquares/float64(len(pixels)) - mean*mean
	}
	outsideVariance := variance(readBlurSample("0.250"))
	insideVariance := variance(readBlurSample("1.000"))
	if insideVariance >= outsideVariance*.5 {
		t.Fatalf("blur did not sufficiently reduce image variance: outside=%f inside=%f", outsideVariance, insideVariance)
	}

	coverSample := exec.Command("ffmpeg", "-v", "error", "-ss", "1.000", "-i", output,
		"-vf", "crop=2:2:960:540,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
	pixel, err := coverSample.Output()
	if err != nil || len(pixel) < 3 {
		t.Fatalf("sample covered pixel: %v (%v)", err, pixel)
	}
	if pixel[0] > 10 || pixel[1] > 10 || pixel[2] > 10 {
		t.Fatalf("cover over blur is not black: rgb=%v", pixel[:3])
	}
}

func TestTimelineCoverTextRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := os.Stat(editorTextFont); err != nil {
		t.Skip("DejaVu Sans render font not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "red.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v: %s", err, out)
	}
	opacity := 0.4
	overlays := []editorCoverOverlay{
		{X: 5, Y: 10, Width: 80, Height: 20, Start: .5, End: 1.5, Color: "#ff8000", Opacity: &opacity,
			Text: "Grüße ÄÖÜ äöü ß : ' \\ % , (Test) %{pts};[vout]"},
		{X: 10, Y: 50, Width: 8, Height: 10, Start: .5, End: 1.5,
			Text: "A very long line that must be clipped inside this narrow cover"},
		{X: 30, Y: 50, Width: 1, Height: 1, Start: .5, End: 1.5, Text: "Too small"},
		{X: 50, Y: 50, Width: 30, Height: 20, Start: .5, End: 1.5, Mode: "blur", Text: "Never visible"},
	}
	if err := prepareCoverTextFiles(dir, overlays); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "text.mp4")
	cmd := exec.Command("ffmpeg", buildTimelineRenderArgs([]string{input},
		[]editClip{{SourceID: "source", SourceEnd: 2, Duration: 2}},
		map[string]int{"source": 0}, map[string]sourceVideo{"source": {}}, output, overlays)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render text (including literal special characters and umlauts): %v: %s", err, out)
	}
	for _, at := range []string{"0.25", "1.0", "1.75"} {
		pixels, err := exec.Command("ffmpeg", "-v", "error", "-ss", at, "-i", output,
			"-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
		if err != nil || len(pixels) != 1920*1080*3 {
			t.Fatalf("sample at %s: %v, %d bytes", at, err, len(pixels))
		}
		counts := [2]int{}
		for p := 0; p < len(pixels); p += 3 {
			// Solid glyph interiors must stay opaque white on the 40% cover.
			if pixels[p] < 235 || pixels[p+1] < 235 || pixels[p+2] < 235 {
				continue
			}
			if at != "1.0" {
				t.Fatalf("text visible outside time window at %s", at)
			}
			x, y := (p/3)%1920, (p/3)/1920
			found := false
			for i := range counts {
				left, top, width, height, _ := coverTextBounds(overlays[i])
				if x >= left && x < left+width && y >= top && y < top+height {
					counts[i]++
					found = true
				}
			}
			if !found {
				t.Fatalf("text escaped cover, or tiny/blur text rendered at %d,%d", x, y)
			}
		}
		if at == "1.0" && (counts[0] < 100 || counts[1] < 30) {
			t.Fatalf("both covers need opaque white text, including alpha cover: %v", counts)
		}
	}
}

func TestTimelineCoverOpacityRenderFFmpegIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").CombinedOutput(); err != nil || !strings.Contains(string(out), "libx264") {
		t.Skip("ffmpeg libx264 encoder not available")
	}

	dir := t.TempDir()
	input := filepath.Join(dir, "red.mp4")
	fixture := exec.Command("ffmpeg", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", input)
	if output, err := fixture.CombinedOutput(); err != nil {
		t.Fatalf("create opacity fixture: %v: %s", err, output)
	}

	output := filepath.Join(dir, "opacity.mp4")
	opacity := 0.5
	clips := []editClip{{ID: "clip", SourceID: "red", SourceStart: 0, SourceEnd: 1, Duration: 1}}
	sources := map[string]sourceVideo{"red": {ID: "red", HasAudio: false}}
	overlays := []editorCoverOverlay{
		{ID: "cover", X: 0, Y: 0, Width: 100, Height: 100, Start: 0, End: 1, Mode: "cover", Color: "#0000ff", Opacity: &opacity},
	}
	cmd := exec.Command("ffmpeg", buildTimelineRenderArgs(
		[]string{input}, clips, map[string]int{"red": 0}, sources, output, overlays,
	)...)
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("render opacity fixture: %v: %s", err, combined)
	}

	sample := exec.Command("ffmpeg", "-v", "error", "-ss", "0.5", "-i", output,
		"-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
	pixel, err := sample.Output()
	if err != nil || len(pixel) < 3 {
		t.Fatalf("sample opacity frame: %v (%v)", err, pixel)
	}
	if pixel[0] < 70 || pixel[2] < 70 || pixel[1] > 40 {
		t.Fatalf("semi-transparent blue cover was not blended over red input: rgb=%v", pixel[:3])
	}
}
