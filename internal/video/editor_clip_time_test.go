package video

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pashagolub/pgxmock/v4"
)

func TestClipSpeedValidation(t *testing.T) {
	if speed, err := readClipSpeed(nil); err != nil || speed != 1 {
		t.Fatal(speed, err)
	}
	for _, speed := range []float64{0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 0, -1, math.NaN(), math.Inf(1), math.Inf(-1), 0.49, 2.01} {
		t.Run(strconv.FormatFloat(speed, 'g', -1, 64), func(t *testing.T) {
			timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceStart: 3, SourceEnd: 13, Speed: &speed})
			valid := !math.IsNaN(speed) && !math.IsInf(speed, 0) && speed >= 0.5 && speed <= 2
			err := validateEditTimeline(&timeline)
			if (err == nil) != valid {
				t.Fatalf("speed %v: %v", speed, err)
			}
			if valid && timeline.Clips[0].Duration != 10 {
				t.Fatal("legacy duration changed")
			}
			if (validateRenderClipSpeeds(timeline.Clips) == nil) != (speed == 1) {
				t.Fatal("render guard")
			}
		})
	}
	if err := validateRenderClipSpeeds([]editClip{{}}); err != nil {
		t.Fatal(err)
	}
}

type clipSpeedJSONArgument struct{ speed *float64 }

func (a clipSpeedJSONArgument) Match(value any) bool {
	raw, ok := value.(json.RawMessage)
	if !ok {
		return false
	}
	var timeline editTimeline
	if json.Unmarshal(raw, &timeline) != nil || len(timeline.Clips) != 1 {
		return false
	}
	got := timeline.Clips[0]
	return got.Duration == 10 && ((got.Speed == nil && a.speed == nil) || (got.Speed != nil && a.speed != nil && *got.Speed == *a.speed))
}

func TestClipSpeedPersistence(t *testing.T) {
	for _, field := range []string{"", `,"speed":1`, `,"speed":1.5`} {
		t.Run(field, func(t *testing.T) {
			body := `{"version":1,"clips":[{"id":"c","sourceId":"v","sourceStart":3,"sourceEnd":13,"duration":10` + field + `}]}`
			var original editTimeline
			if err := json.Unmarshal([]byte(body), &original); err != nil {
				t.Fatal(err)
			}
			mock, err := pgxmock.NewPool()
			if err != nil {
				t.Fatal(err)
			}
			defer mock.Close()
			handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
			mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, updated_at = now\(\)`).WithArgs(clipSpeedJSONArgument{original.Clips[0].Speed}, "video-main", testUserID).WillReturnResult(pgxmock.NewResult("UPDATE", 1))
			mock.ExpectQuery(`SELECT COALESCE\(edit_timeline`).WithArgs("video-main", testUserID).WillReturnRows(pgxmock.NewRows([]string{"edit_timeline", "edit_render_status", "edit_render_error", "edit_render_video_id"}).AddRow([]byte(body), "none", nil, nil))
			router := chi.NewRouter()
			router.With(newAuthMiddleware()).Put("/api/videos/{id}/editor", handler.SaveEditorTimeline)
			router.With(newAuthMiddleware()).Get("/api/videos/{id}/editor", handler.GetEditorState)
			saved := httptest.NewRecorder()
			router.ServeHTTP(saved, authenticatedRequest(t, http.MethodPut, "/api/videos/video-main/editor", []byte(body)))
			if saved.Code != http.StatusNoContent {
				t.Fatal(saved.Code, saved.Body.String())
			}
			loaded := httptest.NewRecorder()
			router.ServeHTTP(loaded, authenticatedRequest(t, http.MethodGet, "/api/videos/video-main/editor", nil))
			if loaded.Code != http.StatusOK {
				t.Fatal(loaded.Code, loaded.Body.String())
			}
			var response editorStateResponse
			if err := json.Unmarshal(loaded.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(response.Timeline)
			if err != nil || !(clipSpeedJSONArgument{original.Clips[0].Speed}).Match(json.RawMessage(encoded)) {
				t.Fatal(string(encoded), err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRenderEditorTimelineRejectsPreparedSpeedBeforeDatabaseAccess(t *testing.T) {
	handler := &Handler{}
	for _, speed := range []string{"0.5", "0.75", "1.25", "1.5", "2"} {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"version":1,"clips":[{"id":"c","sourceId":"v","sourceStart":0,"sourceEnd":10,"speed":`+speed+`}]}`))
		response := httptest.NewRecorder()
		handler.RenderEditorTimeline(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "not supported yet") {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}
