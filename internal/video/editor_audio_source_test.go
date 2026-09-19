package video

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAudioSourceTrackContract(t *testing.T) {
	for _, raw := range []string{
		`{"id":"a","sourceClipId":"c","sourceVideoId":"v","sourceEnd":2}`,
		`{"id":"a","trackId":"original","sourceClipId":"c","sourceVideoId":"v","sourceEnd":2}`,
		`{"id":"a","trackId":"original","source":{"kind":"video","videoId":"v","clipId":"c"},"sourceEnd":2}`,
		`{"id":"a","trackId":"voiceover-1","source":{"kind":"audioAsset","assetId":"asset"},"sourceEnd":2,"geometryLinked":false,"speed":1,"muted":true,"volume":0.5}`,
	} {
		var s editorAudioSegment
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			t.Fatal(err)
		}
		timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceEnd: 10})
		segments := []editorAudioSegment{s}
		timeline.AudioSegments = &segments
		if err := validateEditTimeline(&timeline); err != nil {
			t.Fatal(raw, err)
		}
		encoded, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		var restored editorAudioSegment
		if err := json.Unmarshal(encoded, &restored); err != nil {
			t.Fatal(err)
		}
		reencoded, _ := json.Marshal(restored)
		if string(encoded) != string(reencoded) {
			t.Fatal("roundtrip changed source")
		}
		if s.Source != nil && strings.Contains(string(encoded), "sourceVideoId") {
			t.Fatal("invented legacy references")
		}
		if s.TrackID == nil && strings.Contains(string(encoded), "trackId") {
			t.Fatal("legacy migrated")
		}
	}
}

func TestAudioTracksOverlapAndRenderGuard(t *testing.T) {
	original, voice := "original", "voiceover-1"
	segments := []editorAudioSegment{{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 2}, {ID: "b", TrackID: &voice, Source: &editorAudioSource{Kind: "audioAsset", AssetID: "asset"}, SourceEnd: 2}}
	timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceEnd: 10})
	timeline.AudioSegments = &segments
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	if err := requireSupportedAudioRender(&segments); err != nil {
		t.Fatal("asset render must be supported", err)
	}
	voiceSegments := []editorAudioSegment{segments[1], segments[1]}
	voiceSegments[1].ID = "second-voice"
	voiceSegments[1].TimelineStart = 1
	voiceTimeline := timeline
	voiceTimeline.AudioSegments = &voiceSegments
	if validateEditTimeline(&voiceTimeline) == nil {
		t.Fatal("overlap within voiceover-1 accepted")
	}
	segments[1].TrackID = &original
	if validateEditTimeline(&timeline) == nil {
		t.Fatal("same-track overlap accepted")
	}
	segments[1] = segments[0]
	segments[1].ID = "b"
	segments[1].TrackID = &voice
	if err := validateEditTimeline(&timeline); err != nil {
		t.Fatal(err)
	}
	if err := requireSupportedAudioRender(&segments); err != nil {
		t.Fatal("mixing must be supported", err)
	}
	segments = segments[:1]
	if err := requireSupportedAudioRender(&segments); err != nil {
		t.Fatal(err)
	}
}

func TestAudioSourceRejectsAmbiguity(t *testing.T) {
	linked := true
	empty := " "
	for _, s := range []editorAudioSegment{
		{Source: &editorAudioSource{Kind: "audioAsset", AssetID: "a"}, SourceVideoID: "fake"},
		{Source: &editorAudioSource{Kind: "audioAsset", AssetID: "a"}, GeometryLinked: &linked},
		{Source: &editorAudioSource{Kind: "audioAsset"}},
		{Source: &editorAudioSource{Kind: "video", VideoID: "v"}},
		{SourceClipID: "c", SourceVideoID: "v", TrackID: &empty},
	} {
		if validateAudioSourceContract(s) == nil {
			t.Fatal("invalid source accepted", s)
		}
	}
}

func TestAudioTracksV1Restrictions(t *testing.T) {
	for _, track := range []string{"voice-over", "voiceover-2", "unknown", "", " original"} {
		t.Run(track, func(t *testing.T) {
			voice := "voiceover-1"
			audio := []editorAudioSegment{
				{ID: "original", SourceVideoID: "v", SourceClipID: "c", SourceEnd: 2},
				{ID: "voice", TrackID: &voice, Source: &editorAudioSource{Kind: "audioAsset", AssetID: "asset"}, SourceEnd: 2},
				{ID: "third", TrackID: &track, Source: &editorAudioSource{Kind: "audioAsset", AssetID: "asset"}, SourceEnd: 2},
			}
			timeline := validTimeline(editClip{ID: "c", SourceID: "v", SourceEnd: 10})
			timeline.AudioSegments = &audio
			if err := validateEditTimeline(&timeline); err == nil || !strings.Contains(err.Error(), "track") {
				t.Fatalf("unknown/third track accepted: %v", err)
			}
		})
	}
}

func TestAudioTypedVideoRenderMatchesLegacy(t *testing.T) {
	clips := []editClip{{ID: "c", SourceID: "v", SourceEnd: 2}}
	legacy := []editorAudioSegment{{ID: "a", SourceClipID: "c", SourceVideoID: "v", SourceEnd: 2}}
	typed := []editorAudioSegment{{ID: "a", Source: &editorAudioSource{Kind: "video", VideoID: "v", ClipID: "c"}, SourceEnd: 2}}
	sources := map[string]sourceVideo{"v": {HasAudio: true, Duration: 2}}
	a := strings.Join(timelineAudioFilters(clips, &legacy, map[string]int{"v": 0}, sources), ";")
	b := strings.Join(timelineAudioFilters(clips, &typed, map[string]int{"v": 0}, sources), ";")
	if a != b {
		t.Fatal("typed source changes existing render", a, b)
	}
	if typed[0].SourceVideoID != "" {
		t.Fatal("render mutated persisted contract")
	}
}
