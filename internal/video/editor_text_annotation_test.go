package video

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pashagolub/pgxmock/v4"
)

type textTimelineArgument struct{ want editorAnnotation }

func (m textTimelineArgument) Match(value interface{}) bool {
	var raw []byte
	switch v := value.(type) {
	case json.RawMessage:
		raw = v
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	default:
		return false
	}
	var timeline editTimeline
	return json.Unmarshal(raw, &timeline) == nil && len(timeline.Annotations) == 1 && reflect.DeepEqual(timeline.Annotations[0], m.want)
}

func TestTextAnnotationSaveReload(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	handler := NewHandler(mock, &mockStorage{}, testBaseURL, 0, 0, 0, 0, testJWTSecret, true)
	timeline := textTestTimeline()
	family, bold, italic := "dejavu-serif", true, false
	timeline.Annotations[0].FontFamily = &family
	timeline.Annotations[0].Bold = &bold
	timeline.Annotations[0].Italic = &italic
	raw, _ := json.Marshal(timeline)
	mock.ExpectExec(`UPDATE videos SET edit_timeline = \$1, updated_at = now\(\)`).
		WithArgs(textTimelineArgument{timeline.Annotations[0]}, "video-main", testUserID).
		WillReturnResult(pgxmock.NewResult("UPDATE", 1))
	mock.ExpectQuery(`SELECT COALESCE\(edit_timeline`).WithArgs("video-main", testUserID).
		WillReturnRows(pgxmock.NewRows([]string{"edit_timeline", "edit_render_status", "edit_render_error", "edit_render_video_id"}).AddRow(raw, "none", (*string)(nil), (*string)(nil)))
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Put("/api/videos/{id}/editor", handler.SaveEditorTimeline)
	router.With(newAuthMiddleware()).Get("/api/videos/{id}/editor", handler.GetEditorState)
	saved := httptest.NewRecorder()
	router.ServeHTTP(saved, authenticatedRequest(t, http.MethodPut, "/api/videos/video-main/editor", raw))
	if saved.Code != http.StatusNoContent {
		t.Fatalf("save: %d %s", saved.Code, saved.Body.String())
	}
	loaded := httptest.NewRecorder()
	router.ServeHTTP(loaded, authenticatedRequest(t, http.MethodGet, "/api/videos/video-main/editor", nil))
	var state editorStateResponse
	if loaded.Code != http.StatusOK || json.Unmarshal(loaded.Body.Bytes(), &state) != nil || !reflect.DeepEqual(state.Timeline.Annotations, timeline.Annotations) {
		t.Fatalf("reload: %s", loaded.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func textTestTimeline() editTimeline {
	timeline := validTimeline(editClip{ID: "clip", SourceID: "source", SourceStart: 0, SourceEnd: 10, Duration: 10})
	timeline.Annotations = []editorAnnotation{{ID: "text", Type: "text", Text: "Grüße aus Oldenburg\näöü ÄÖÜ ß\n<b>Hinweis</b>", X: 10, Y: 20, Width: 40, Height: 10, Start: 1, End: 4, FontSize: 32, Color: "#Ab12Cd"}}
	return timeline
}

func TestTextAnnotationTypography(t *testing.T) {
	for _, family := range []string{"dejavu-sans", "dejavu-serif", "dejavu-mono", "", "Arial"} {
		for _, bold := range []bool{false, true} {
			for _, italic := range []bool{false, true} {
				a := textTestTimeline().Annotations[0]
				a.FontFamily, a.Bold, a.Italic = &family, &bold, &italic
				err := validateTextAnnotation(a, 10)
				if (err != nil) != (family == "" || family == "Arial") {
					t.Fatalf("font %q: %v", family, err)
				}
				raw, _ := json.Marshal(a)
				var restored editorAnnotation
				if json.Unmarshal(raw, &restored) != nil || !reflect.DeepEqual(a, restored) {
					t.Fatalf("roundtrip: %s", raw)
				}
			}
		}
	}
	for _, raw := range []string{`{"bold":"true"}`, `{"italic":1}`, `{"fontFamily":42}`} {
		var a editorAnnotation
		if json.Unmarshal([]byte(raw), &a) == nil {
			t.Fatalf("accepted wrong field type: %s", raw)
		}
	}
	legacy := textTestTimeline().Annotations[0]
	raw, _ := json.Marshal(legacy)
	if strings.Contains(string(raw), "fontFamily") || strings.Contains(string(raw), "bold") || strings.Contains(string(raw), "italic") {
		t.Fatalf("legacy changed: %s", raw)
	}
}

func TestTextAnnotationRoundtrip(t *testing.T) {
	timeline := textTestTimeline()
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(timeline)
	if err != nil {
		t.Fatal(err)
	}
	var restored editTimeline
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(timeline.Annotations, restored.Annotations) {
		t.Fatalf("lost text fields: %s", raw)
	}
	if strings.Contains(string(raw), `"rotation"`) || strings.Contains(string(raw), `"symbol"`) {
		t.Fatalf("text gained unsupported fields: %s", raw)
	}
	shape := editorAnnotation{Type: "arrow", Rotation: 37}
	encoded, _ := json.Marshal(shape)
	if !strings.Contains(string(encoded), `"rotation":37`) {
		t.Fatalf("legacy shape changed: %s", encoded)
	}
}

func TestTextAnnotationValidation(t *testing.T) {
	cases := map[string]func(*editorAnnotation){
		"empty": func(a *editorAnnotation) { a.Text = "" }, "spaces": func(a *editorAnnotation) { a.Text = "  " },
		"invisible": func(a *editorAnnotation) { a.Text = "\u200b" }, "long": func(a *editorAnnotation) { a.Text = strings.Repeat("ä", 121) },
		"control": func(a *editorAnnotation) { a.Text = "a\x01" }, "invalid utf8": func(a *editorAnnotation) { a.Text = string([]byte{255}) },
		"only newline": func(a *editorAnnotation) { a.Text = "\n" }, "whitespace lines": func(a *editorAnnotation) { a.Text = " \t\n \n" },
		"small font": func(a *editorAnnotation) { a.FontSize = 7 }, "large font": func(a *editorAnnotation) { a.FontSize = 257 },
		"nan": func(a *editorAnnotation) { a.FontSize = math.NaN() }, "infinite": func(a *editorAnnotation) { a.X = math.Inf(1) },
		"negative": func(a *editorAnnotation) { a.X = -1 }, "overflow": func(a *editorAnnotation) { a.X = 90 },
		"zero box": func(a *editorAnnotation) { a.Height = 0 }, "color": func(a *editorAnnotation) { a.Color = "#fff" },
		"time": func(a *editorAnnotation) { a.End = 11 }, "rotation": func(a *editorAnnotation) { a.Rotation = 37 },
		"unknown": func(a *editorAnnotation) { a.Type = "unknown" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			timeline := textTestTimeline()
			mutate(&timeline.Annotations[0])
			if validateEditTimeline(&timeline) == nil {
				t.Fatal("invalid annotation accepted")
			}
		})
	}
	for _, size := range []float64{8, 256} {
		timeline := textTestTimeline()
		timeline.Annotations[0].FontSize = size
		timeline.Annotations[0].Color = ""
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"Einzeilig äöüß", "Zeile 1\nZeile 2", strings.Repeat("ä", 119) + "\n"} {
		timeline := textTestTimeline()
		timeline.Annotations[0].Text = value
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatal(err)
		}
	}
	timeline := textTestTimeline()
	timeline.Annotations[0].Text = strings.Repeat("ä", 119) + "\nß"
	if validateEditTimeline(&timeline) == nil {
		t.Fatal("newline must count toward text length")
	}
}

func TestTextAnnotationRenderGuards(t *testing.T) {
	timeline := textTestTimeline()
	raw, _ := json.Marshal(timeline)
	handler := &Handler{}
	response := httptest.NewRecorder()
	handler.RenderEditorTimeline(response, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(raw))))
	const message = "Text annotations are not yet supported for rendering"
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), message) {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if err := prepareArrowFiles(t.TempDir(), timeline); err == nil || err.Error() != message {
		t.Fatalf("worker silently accepts text: %v", err)
	}
}
