package video

import (
	"encoding/json"
	"strings"
	"testing"
)

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
