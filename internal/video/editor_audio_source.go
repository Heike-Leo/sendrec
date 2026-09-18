package video

import (
	"fmt"
	"sort"
	"strings"
)

// Source is optional only for legacy video/clip references. Assets are not videos.
type editorAudioSource struct {
	Kind    string `json:"kind"`
	VideoID string `json:"videoId,omitempty"`
	ClipID  string `json:"clipId,omitempty"`
	AssetID string `json:"assetId,omitempty"`
}

func audioTrackID(s editorAudioSegment) string {
	if s.TrackID == nil {
		return "original"
	}
	return *s.TrackID
}

func validateAudioSourceContract(s editorAudioSegment) error {
	if track := audioTrackID(s); track != "original" && track != "voiceover-1" {
		return fmt.Errorf("invalid audio track id")
	}
	if s.Source == nil {
		if strings.TrimSpace(s.SourceClipID) == "" || strings.TrimSpace(s.SourceVideoID) == "" {
			return fmt.Errorf("audio segment requires source references")
		}
		return nil
	}
	if s.SourceClipID != "" || s.SourceVideoID != "" {
		return fmt.Errorf("ambiguous audio source references")
	}
	r := s.Source
	switch r.Kind {
	case "video":
		if strings.TrimSpace(r.VideoID) != "" && strings.TrimSpace(r.ClipID) != "" && r.AssetID == "" {
			return nil
		}
	case "audioAsset":
		if strings.TrimSpace(r.AssetID) != "" && r.VideoID == "" && r.ClipID == "" && (s.GeometryLinked == nil || !*s.GeometryLinked) {
			return nil
		}
	}
	return fmt.Errorf("invalid audio source reference")
}

// A local playback projection only; persisted JSON retains its original representation.
func videoAudioProjection(s editorAudioSegment) editorAudioSegment {
	if s.Source != nil && s.Source.Kind == "video" {
		s.SourceVideoID = s.Source.VideoID
		s.SourceClipID = s.Source.ClipID
	}
	return s
}

func validateAudioTrackGeometry(clips []editClip, audio []editorAudioSegment) error {
	ordered := append([]editorAudioSegment{}, audio...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].TimelineStart < ordered[j].TimelineStart })
	ends := map[string]float64{}
	for _, s := range ordered {
		speed, err := effectiveRenderAudioSpeed(s, clips)
		if err != nil {
			return err
		}
		if s.SourceEnd == s.SourceStart {
			continue
		}
		track := audioTrackID(s)
		if s.TimelineStart < ends[track]-editorAudioTolerance {
			return fmt.Errorf("audio segments on the same track must not overlap")
		}
		ends[track] = s.TimelineStart + (s.SourceEnd-s.SourceStart)/speed
	}
	return nil
}

// Until asset resolution and mixing exist, fail explicitly instead of omitting sound.
func requireSupportedAudioRender(segments *[]editorAudioSegment) error {
	if segments == nil {
		return nil
	}
	tracks := map[string]bool{}
	for _, s := range *segments {
		if s.Source != nil && s.Source.Kind == "audioAsset" {
			return fmt.Errorf("audio asset rendering is not supported yet")
		}
		tracks[audioTrackID(s)] = true
	}
	if len(tracks) > 1 {
		return fmt.Errorf("multitrack audio rendering is not supported yet")
	}
	return nil
}
