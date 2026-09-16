package video

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAudioSpeedValidationAndRenderGuard(t *testing.T) {
	for _, speed := range []float64{0.5, 0.75, 1, 1.25, 1.5, 2, 0, -1, math.NaN(), math.Inf(1), math.Inf(-1), 0.49, 2.01} {
		timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceEnd: 10})
		segments := []editorAudioSegment{{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 10, Speed: &speed}}
		timeline.AudioSegments = &segments
		valid := !math.IsNaN(speed) && !math.IsInf(speed, 0) && speed >= 0.5 && speed <= 2
		if (validateEditTimeline(&timeline) == nil) != valid {
			t.Fatalf("validation for %v", speed)
		}
		if (validateRenderAudioSpeeds(&segments) == nil) != valid {
			t.Fatalf("render guard for %v", speed)
		}
	}
	if rate, err := readAudioSpeed(nil); rate != 1 || err != nil {
		t.Fatal(rate, err)
	}
	handler := &Handler{}
	for _, speed := range []string{"0", "-1", "3"} {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"version":1,"clips":[{"id":"c","sourceId":"v","sourceStart":0,"sourceEnd":10}],"audioSegments":[{"id":"a","sourceClipId":"c","sourceVideoId":"v","sourceStart":0,"sourceEnd":10,"timelineStart":0,"speed":`+speed+`}]}`))
		response := httptest.NewRecorder()
		handler.RenderEditorTimeline(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "audio segment speed") {
			t.Fatal(response.Code, response.Body.String())
		}
	}
}

func TestAudioGeometryLinkedRoundTrip(t *testing.T) {
	for _, field := range []string{"", `,"geometryLinked":true`, `,"geometryLinked":false`} {
		t.Run(field, func(t *testing.T) {
			raw := `{"id":"a","sourceClipId":"c","sourceVideoId":"v","sourceStart":0,"sourceEnd":10,"timelineStart":0` + field + `}`
			var segment editorAudioSegment
			if err := json.Unmarshal([]byte(raw), &segment); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(segment)
			if err != nil {
				t.Fatal(err)
			}
			if field == "" {
				if segment.GeometryLinked != nil || strings.Contains(string(data), "geometryLinked") {
					t.Fatal(string(data))
				}
			} else if segment.GeometryLinked == nil || !strings.Contains(string(data), field[1:]) {
				t.Fatal(string(data))
			}
			stored := []editorAudioSegment{segment}
			actual := renderAudioSegments(nil, &stored)
			out, _ := json.Marshal(actual[0])
			if string(out) != string(data) {
				t.Fatal("stored metadata changed")
			}
		})
	}
	derived := renderAudioSegments([]editClip{{ID: "c", SourceID: "v", SourceEnd: 10}}, nil)
	if derived[0].GeometryLinked == nil || !*derived[0].GeometryLinked {
		t.Fatal("new original audio must be linked")
	}
}
