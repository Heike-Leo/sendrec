package video

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/pashagolub/pgxmock/v4"
	"github.com/sendrec/sendrec/internal/auth"
)

func multitrackFixture() (editTimeline, map[string]sourceVideo, map[string]int) {
	voice, linked, unlinked, speed := "voiceover-1", true, false, 2.0
	segments := []editorAudioSegment{
		{ID: "original", SourceVideoID: "v", SourceClipID: "c", SourceEnd: 4, GeometryLinked: &linked},
		{ID: "voice", TrackID: &voice, Source: &editorAudioSource{Kind: "audioAsset", AssetID: testAudioAssetID}, SourceStart: .25, SourceEnd: 1.25, TimelineStart: .5, GeometryLinked: &unlinked},
	}
	timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceEnd: 4, Speed: &speed})
	timeline.AudioSegments = &segments
	key := audioRenderSourceKey(segments[1])
	return timeline, map[string]sourceVideo{"v": {ID: "v", Duration: 4, HasAudio: true}, key: {ID: key, HasAudio: true, AudioAsset: &audioAsset{Duration: 2}}}, map[string]int{"v": 0, key: 1}
}

func TestMultitrackGraphAndValidation(t *testing.T) {
	timeline, sources, indexes := multitrackFixture()
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(timeline)
	graph := strings.Join(timelineAudioFilters(timeline.Clips, timeline.AudioSegments, indexes, sources), ";")
	for _, want := range []string{"amix=inputs=2:duration=longest:dropout_transition=0:normalize=0", "[mix0][mix1]", "atrim=end_sample=96000", "[1:a:0]atrim=start=0.250000000:end=1.250000000", "atempo=2.000000000"} {
		if !strings.Contains(graph, want) {
			t.Fatal("missing", want, graph)
		}
	}
	if strings.Count(graph, "atempo=") != 1 {
		t.Fatal("speed applied twice", graph)
	}
	after, _ := json.Marshal(timeline)
	if !bytes.Equal(before, after) {
		t.Fatal("render mutated persisted data")
	}
	voice := (*timeline.AudioSegments)[1]
	for _, tc := range []struct {
		name   string
		change func(*editorAudioSegment)
	}{
		{"bounds", func(s *editorAudioSegment) { s.SourceEnd = 2.01 }},
		{"negative", func(s *editorAudioSegment) { s.SourceStart = -.1 }},
		{"speed", func(s *editorAudioSegment) { rate := 2.0; s.Speed = &rate }},
		{"linked_asset", func(s *editorAudioSegment) { yes := true; s.GeometryLinked = &yes }},
		{"missing", func(s *editorAudioSegment) { s.Source = &editorAudioSource{Kind: "audioAsset", AssetID: "missing"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := voice
			tc.change(&s)
			segments := []editorAudioSegment{(*timeline.AudioSegments)[0], s}
			copy := timeline
			copy.AudioSegments = &segments
			if validateRenderAudio(copy, sources) == nil {
				t.Fatal("invalid audio accepted")
			}
		})
	}
	segments := []editorAudioSegment{voice, voice}
	segments[1].ID = "other"
	timeline.AudioSegments = &segments
	if validateRenderAudio(timeline, sources) == nil {
		t.Fatal("same-track overlap accepted")
	}
	segments = segments[:1]
	if err := validateRenderAudio(timeline, sources); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(timelineAudioFilters(timeline.Clips, &segments, indexes, sources), ";"), "amix") {
		t.Fatal("voice-only unnecessarily mixed")
	}
}

func TestMultitrackSourceIdentity(t *testing.T) {
	timeline, _, _ := multitrackFixture()
	timeline.Clips[0].SourceID = testAudioAssetID
	(*timeline.AudioSegments)[0].SourceVideoID = testAudioAssetID
	want := []string{testAudioAssetID, "audioAsset:" + testAudioAssetID}
	if !reflect.DeepEqual(renderInputKeys(timeline), want) {
		t.Fatal(renderInputKeys(timeline))
	}
	if !reflect.DeepEqual(renderSourceIDs(timeline), want[:1]) {
		t.Fatal("asset treated as video")
	}
}

func TestMultitrackLegacyGraphUnchanged(t *testing.T) {
	// Frozen pre-3b graph: source offset, volume, speed and gap remain verbatim.
	rate, volume := 2.0, .5
	clips := []editClip{{ID: "c", SourceID: "v", SourceEnd: 2}}
	audio := []editorAudioSegment{{ID: "a", SourceVideoID: "v", SourceStart: .25, SourceEnd: 2.25, TimelineStart: .5, Speed: &rate, Volume: &volume}}
	want := "anullsrc=r=48000:cl=stereo,atrim=end_sample=24000,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp[at0];" +
		"[0:a:0]atrim=start=0.250000000:end=2.250000000,asetpts=PTS-0.250000000/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atempo=2.000000000,asetpts=PTS-STARTPTS+STARTPTS/2.000000000,aresample=48000:first_pts=0,volume=0.500000000,apad=whole_len=48000,atrim=end_sample=48000,asetpts=PTS-STARTPTS[at1];" +
		"anullsrc=r=48000:cl=stereo,atrim=end_sample=24000,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp[at2];" +
		"[at0][at1][at2]concat=n=3:v=0:a=1,apad=whole_len=96000,atrim=end_sample=96000,asetpts=PTS-STARTPTS[aout]"
	got := strings.Join(timelineAudioFilters(clips, &audio, map[string]int{"v": 0}, map[string]sourceVideo{"v": {HasAudio: true}}), ";")
	if got != want {
		t.Fatalf("legacy graph changed\n%s", got)
	}
}

func TestMultitrackAssetAuthorization(t *testing.T) {
	for _, found := range []bool{true, false} {
		mock, err := pgxmock.NewPool()
		if err != nil {
			t.Fatal(err)
		}
		defer mock.Close()
		h := NewHandler(mock, nil, "", 0, 0, 0, 0, "", false)
		timeline, _, _ := multitrackFixture()
		q := mock.ExpectQuery(`SELECT id, storage_key.*`).WithArgs(testAudioAssetID, testUserID, "")
		if found {
			q.WillReturnRows(testAudioAssetRows(2))
		} else {
			q.WillReturnError(pgx.ErrNoRows)
		}
		sources := map[string]sourceVideo{}
		err = h.resolveRenderAudioAssets(auth.ContextWithUserID(context.Background(), testUserID), timeline, sources)
		if (err == nil) != found {
			t.Fatal(found, err)
		}
		if found && sources["audioAsset:"+testAudioAssetID].AudioAsset.Duration != 2 {
			t.Fatal("metadata missing")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}
	timeline, _, _ := multitrackFixture()
	if (&Handler{}).resolveRenderAudioAssets(context.Background(), timeline, map[string]sourceVideo{}) == nil {
		t.Fatal("anonymous asset accepted")
	}
	h := &Handler{storage: &mockStorage{downloadToFileErr: fmt.Errorf("missing object")}}
	if h.downloadRenderSource(context.Background(), sourceVideo{AudioAsset: &audioAsset{}}, filepath.Join(t.TempDir(), "asset.m4a")) == nil {
		t.Fatal("missing object silently ignored")
	}
	// Workspace is part of the fresh authorization query, not taken from the asset reference.
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	ctx := auth.ContextWithOrg(auth.ContextWithUserID(context.Background(), testUserID), "other-workspace", "member")
	mock.ExpectQuery(`SELECT id, storage_key`).WithArgs(testAudioAssetID, testUserID, "other-workspace").WillReturnError(pgx.ErrNoRows)
	if NewHandler(mock, nil, "", 0, 0, 0, 0, "", false).resolveRenderAudioAssets(ctx, timeline, map[string]sourceVideo{}) == nil {
		t.Fatal("foreign workspace accepted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMultitrackRenderEndpoint(t *testing.T) {
	for _, found := range []bool{true, false} {
		mock, err := pgxmock.NewPool()
		if err != nil {
			t.Fatal(err)
		}
		defer mock.Close()
		h := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
		mock.ExpectQuery(`SELECT user_id, organization_id, title FROM videos`).WithArgs("v", testUserID).WillReturnRows(pgxmock.NewRows([]string{"user_id", "organization_id", "title"}).AddRow(testUserID, nil, "Original"))
		mock.ExpectQuery(`SELECT file_key, content_type, duration FROM videos`).WithArgs("v", testUserID).WillReturnRows(pgxmock.NewRows([]string{"file_key", "content_type", "duration"}).AddRow("video.mp4", "video/mp4", 4))
		q := mock.ExpectQuery(`SELECT id, storage_key`).WithArgs(testAudioAssetID, testUserID, "")
		if found {
			q.WillReturnRows(testAudioAssetRows(2))
			mock.ExpectExec(`UPDATE videos SET edit_timeline`).WithArgs(pgxmock.AnyArg(), "v", testUserID).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
		} else {
			q.WillReturnError(pgx.ErrNoRows)
		}
		previous := enqueueTimelineRender
		var queued *renderJob
		enqueueTimelineRender = func(_ *Handler, job renderJob) { queued = &job }
		timeline, _, _ := multitrackFixture()
		raw, _ := json.Marshal(timeline)
		router := chi.NewRouter()
		router.With(newAuthMiddleware()).Post("/api/videos/{id}/editor/render", h.RenderEditorTimeline)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, authenticatedRequest(t, http.MethodPost, "/api/videos/v/editor/render", raw))
		enqueueTimelineRender = previous
		if found {
			if response.Code != http.StatusAccepted || queued == nil || queued.Sources["audioAsset:"+testAudioAssetID].FileKey != "audio-assets/"+testAudioAssetID {
				t.Fatal(response.Code, response.Body.String(), queued)
			}
		} else if response.Code != http.StatusBadRequest || queued != nil {
			t.Fatal("foreign/missing asset queued", response.Code)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMultitrackFFmpegIntegration(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	dir := t.TempDir()
	inputs := []string{filepath.Join(dir, "original.mkv"), filepath.Join(dir, "voice.m4a")}
	for i, path := range inputs {
		args := []string{"-v", "error", "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=48000:duration=4", 440+i*440)}
		if i == 0 {
			// A zero-origin video stream keeps the real audio PTS offset on input.
			args = append(args, "-f", "lavfi", "-i", "color=size=320x180:rate=30:duration=4", "-filter_complex", "[0:a]asetpts=PTS+0.057/TB[a]", "-map", "1:v", "-map", "[a]", "-c:v", "ffv1", "-c:a", "pcm_s16le")
		} else {
			args = append(args, "-c:a", "aac")
		}
		if out, err := exec.Command("ffmpeg", append(args, "-y", path)...).CombinedOutput(); err != nil {
			t.Fatal(err, string(out))
		}
	}
	timeline, sources, indexes := multitrackFixture()
	decode := func(audio []editorAudioSegment) []float32 {
		t.Helper()
		args := []string{"-v", "error", "-i", inputs[0], "-i", inputs[1], "-filter_complex", strings.Join(timelineAudioFilters(timeline.Clips, &audio, indexes, sources), ";"), "-map", "[aout]", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"}
		var stderr bytes.Buffer
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stderr = &stderr
		raw, err := cmd.Output()
		if err != nil {
			t.Fatal(err, stderr.String())
		}
		if len(raw) != 2*48000*2*4 {
			t.Fatalf("wrong stereo sample count: %d", len(raw))
		}
		pcm := make([]float32, len(raw)/4)
		for i := range pcm {
			pcm[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4:]))
		}
		return pcm
	}
	for _, tc := range []struct {
		name                    string
		muteOriginal, muteVoice bool
		gain                    float64
		multiple                bool
	}{
		{"overlap", false, false, 1, false}, {"volume", false, false, .3, false}, {"mute_voice", false, true, 1, false}, {"mute_original", true, false, 1, false}, {"both_muted", true, true, 1, false}, {"multiple_voice_segments", false, false, .5, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			audio := append([]editorAudioSegment{}, (*timeline.AudioSegments)...)
			audio[0].Muted = tc.muteOriginal
			audio[1].Muted = tc.muteVoice
			audio[1].Volume = &tc.gain
			if tc.multiple {
				audio[1].SourceEnd = .75
				second := audio[1]
				second.ID = "voice2"
				second.TimelineStart = 1.25
				audio = append(audio, second)
			}
			original, voice, mixed := decode(audio[:1]), decode(audio[1:]), decode(audio)
			for i := range mixed {
				if math.Abs(float64(mixed[i]-original[i]-voice[i])) > 1e-6 {
					t.Fatalf("sample %d: mix not unnormalized sum", i)
				}
			}
			// Leading/trailing voice gaps and original source PTS offset are retained.
			for i := 0; i < 12000*2; i++ {
				if voice[i] != 0 {
					t.Fatal("voice gap lost")
				}
			}
			for i := 0; i < 1300*2; i++ {
				if original[i] != 0 {
					t.Fatal("original source offset lost at 2x")
				}
			}
			if !tc.muteVoice {
				peak := float32(0)
				for _, v := range voice {
					if v > peak {
						peak = v
					}
				}
				if peak < .01 {
					t.Fatal("missing voice")
				}
			}
		})
	}
	// Both tracks alternate between audible and muted segments without moving
	// their timeline positions. This also exercises repeated use of one input.
	partial := append([]editorAudioSegment{}, (*timeline.AudioSegments)...)
	partial[0].GeometryLinked = linkValue(false)
	partial[0].Speed = speedValue(2)
	partial[0].SourceEnd = 2
	secondOriginal := partial[0]
	secondOriginal.ID = "original2"
	secondOriginal.SourceStart = 2
	secondOriginal.SourceEnd = 4
	secondOriginal.TimelineStart = 1
	secondOriginal.Muted = true
	partial[1].SourceEnd = .75
	secondVoice := partial[1]
	secondVoice.ID = "voice2"
	secondVoice.SourceStart = .75
	secondVoice.SourceEnd = 1.25
	secondVoice.TimelineStart = 1
	secondVoice.Muted = true
	partial = append(partial, secondOriginal, secondVoice)
	partialTimeline := timeline
	partialTimeline.AudioSegments = &partial
	if err := validateRenderAudio(partialTimeline, sources); err != nil {
		t.Fatal(err)
	}
	partialPCM := decode(partial)
	for i := 48000 * 2; i < len(partialPCM); i++ {
		if partialPCM[i] != 0 {
			t.Fatal("partially muted tail not silent")
		}
	}
	empty := decode(nil)
	for _, sample := range empty {
		if sample != 0 {
			t.Fatal("empty audio not silent")
		}
	}
	// Exercise the full video + mixed AAC output, not only the isolated audio graph.
	output := filepath.Join(dir, "mixed.mp4")
	args := buildTimelineRenderArgsWithAudio(inputs, timeline.Clips, indexes, sources, output, nil, timeline.AudioSegments)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	raw, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration,sample_rate,channels:format=duration", "-of", "json", output).Output()
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		Streams []struct {
			Type     string `json:"codec_type"`
			Duration string `json:"duration"`
			Rate     string `json:"sample_rate"`
			Channels int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatal(err)
	}
	if len(probe.Streams) != 2 {
		t.Fatal(string(raw))
	}
	for _, stream := range probe.Streams {
		var duration float64
		if _, err := fmt.Sscan(stream.Duration, &duration); err != nil || math.Abs(duration-2) > .001 {
			t.Fatal("stream duration", string(raw))
		}
		if stream.Type == "audio" && (stream.Rate != "48000" || stream.Channels != 2) {
			t.Fatal("audio format", string(raw))
		}
	}
	var duration float64
	if _, err := fmt.Sscan(probe.Format.Duration, &duration); err != nil || math.Abs(duration-2) > .001 {
		t.Fatal("container duration", string(raw))
	}
}
