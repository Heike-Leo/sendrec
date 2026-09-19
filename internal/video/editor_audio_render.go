package video

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Match the existing source-duration tolerance: at most one millisecond.
const editorAudioTolerance = .001

func readAudioSpeed(speed *float64) (float64, error) {
	rate, err := readClipSpeed(speed)
	if err != nil {
		return 0, fmt.Errorf("audio segment speed must be finite and between 0.5 and 2.0")
	}
	return rate, nil
}

func validateRenderAudioSpeeds(segments *[]editorAudioSegment) error {
	if err := requireSupportedAudioRender(segments); err != nil {
		return err
	}
	if segments == nil {
		return nil
	}
	for _, segment := range *segments {
		_, err := readAudioSpeed(segment.Speed)
		if err != nil {
			return err
		}
	}
	return nil
}

// Linked audio inherits exactly once, and only from its uniquely identified,
// geometrically matching clip. Inconsistent explicit linkage is a render error.
func effectiveRenderAudioSpeed(segment editorAudioSegment, clips []editClip) (float64, error) {
	segment = videoAudioProjection(segment)
	own, err := readAudioSpeed(segment.Speed)
	if err != nil || segment.GeometryLinked == nil || !*segment.GeometryLinked {
		return own, err
	}
	offset, rate, matches := 0.0, 0.0, 0
	for _, clip := range clips {
		speed, err := readClipSpeed(clip.Speed)
		if err != nil {
			return 0, err
		}
		if clip.ID == segment.SourceClipID {
			matches++
			if clip.SourceID != segment.SourceVideoID || math.Abs(clip.SourceStart-segment.SourceStart) > 1e-6 ||
				math.Abs(clip.SourceEnd-segment.SourceEnd) > 1e-6 || math.Abs(offset-segment.TimelineStart) > 1e-6 {
				return 0, fmt.Errorf("linked audio geometry does not match video clip")
			}
			rate = speed
		}
		offset += clipTimelineDuration(clip)
	}
	if matches != 1 {
		return 0, fmt.Errorf("linked audio requires one matching video clip")
	}
	return rate, nil
}

func validateAudioVolume(volume *float64) error {
	if volume != nil && (math.IsNaN(*volume) || math.IsInf(*volume, 0) || *volume < 0 || *volume > 1) {
		return fmt.Errorf("audio segment volume must be finite and between 0 and 1")
	}
	return nil
}

func renderAudioSegments(clips []editClip, stored *[]editorAudioSegment) []editorAudioSegment {
	if stored != nil {
		result := append([]editorAudioSegment{}, (*stored)...)
		for i := range result {
			result[i] = videoAudioProjection(result[i])
		}
		return result
	}
	segments := make([]editorAudioSegment, 0, len(clips))
	offset := 0.0
	for _, clip := range clips {
		linked := true
		segments = append(segments, editorAudioSegment{GeometryLinked: &linked, ID: "audio:" + clip.ID, SourceClipID: clip.ID,
			SourceVideoID: clip.SourceID, SourceStart: clip.SourceStart, SourceEnd: clip.SourceEnd, TimelineStart: offset})
		offset += clipTimelineDuration(clip)
	}
	return segments
}

// Stable input numbering, including sources referenced only by audio.
func renderSourceIDs(timeline editTimeline) []string {
	var ids []string
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, clip := range timeline.Clips {
		add(clip.SourceID)
	}
	for _, segment := range renderAudioSegments(timeline.Clips, timeline.AudioSegments) {
		if segment.Source == nil || segment.Source.Kind != "audioAsset" {
			add(segment.SourceVideoID)
		}
	}
	return ids
}

func validateRenderAudio(timeline editTimeline, sources map[string]sourceVideo) error {
	if err := requireSupportedAudioRender(timeline.AudioSegments); err != nil {
		return err
	}
	if err := validateRenderClipSpeeds(timeline.Clips); err != nil {
		return err
	}
	duration := 0.0
	for _, clip := range timeline.Clips {
		duration += clipTimelineDuration(clip)
	}
	segments := renderAudioSegments(timeline.Clips, timeline.AudioSegments)
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].TimelineStart < segments[j].TimelineStart })
	ends := map[string]float64{}
	for _, s := range segments {
		speed, err := effectiveRenderAudioSpeed(s, timeline.Clips)
		if err != nil {
			return err
		}
		if err := validateAudioVolume(s.Volume); err != nil {
			return err
		}
		for _, v := range []float64{s.SourceStart, s.SourceEnd, s.TimelineStart} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return fmt.Errorf("audio segment times must be finite")
			}
		}
		if s.SourceStart < 0 || s.SourceEnd < s.SourceStart || s.TimelineStart < 0 {
			return fmt.Errorf("audio segment time range is invalid")
		}
		source, ok := sources[audioRenderSourceKey(s)]
		if !ok {
			return fmt.Errorf("audio segment references an unavailable source")
		}
		sourceDuration := float64(source.Duration)
		if source.AudioAsset != nil {
			sourceDuration = source.AudioAsset.Duration
		}
		if s.Source != nil && s.Source.Kind == "audioAsset" && source.AudioAsset == nil {
			return fmt.Errorf("audio asset metadata unavailable")
		}
		if s.SourceEnd > sourceDuration+editorAudioTolerance {
			return fmt.Errorf("audio segment exceeds source duration")
		}
		segmentEnd := s.TimelineStart + (s.SourceEnd-s.SourceStart)/speed
		if segmentEnd > duration+editorAudioTolerance {
			return fmt.Errorf("audio segment exceeds timeline duration")
		}
		if s.SourceEnd == s.SourceStart {
			continue
		}
		track := audioTrackID(s)
		if s.TimelineStart < ends[track]-editorAudioTolerance {
			return fmt.Errorf("audio segments must not overlap")
		}
		ends[track] = math.Max(ends[track], segmentEnd)
	}
	return nil
}

// Preserve the single-track graph verbatim; mix only genuinely distinct tracks.
func timelineAudioFilters(clips []editClip, stored *[]editorAudioSegment, indexes map[string]int, sources map[string]sourceVideo) []string {
	tracks := map[string][]editorAudioSegment{}
	if stored != nil {
		for _, s := range *stored {
			tracks[audioTrackID(s)] = append(tracks[audioTrackID(s)], s)
		}
	}
	if len(tracks) <= 1 {
		return singleTrackAudioFilters(clips, stored, indexes, sources, "", "aout")
	}
	var filters []string
	for i, track := range []string{"original", "voiceover-1"} {
		segments := tracks[track]
		filters = append(filters, singleTrackAudioFilters(clips, &segments, indexes, sources, fmt.Sprintf("mix%d_", i), fmt.Sprintf("mix%d", i))...)
	}
	duration := 0.0
	for _, clip := range clips {
		duration += clipTimelineDuration(clip)
	}
	total := int64(math.Round(duration * 48000))
	filters = append(filters, fmt.Sprintf("[mix0][mix1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=%d,atrim=end_sample=%d,asetpts=PTS-STARTPTS[aout]", total, total))
	return filters
}

// Boundaries are rounded to 48-kHz sample positions to avoid cumulative drift.
func singleTrackAudioFilters(clips []editClip, stored *[]editorAudioSegment, indexes map[string]int, sources map[string]sourceVideo, prefix, output string) []string {
	segments := renderAudioSegments(clips, stored)
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].TimelineStart < segments[j].TimelineStart })
	duration := 0.0
	for _, clip := range clips {
		duration += clipTimelineDuration(clip)
	}
	total := int64(math.Round(duration * 48000))
	var filters []string
	var labels strings.Builder
	parts := 0
	appendPart := func(filter string) {
		label := fmt.Sprintf("%sat%d", prefix, parts)
		filters = append(filters, filter+"["+label+"]")
		fmt.Fprintf(&labels, "[%s]", label)
		parts++
	}
	silence := func(samples int64) {
		if samples > 0 {
			appendPart(fmt.Sprintf("anullsrc=r=48000:cl=stereo,atrim=end_sample=%d,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp", samples))
		}
	}
	cursor := int64(0)
	for _, s := range segments {
		speed, _ := effectiveRenderAudioSpeed(s, clips) // validated before the render job is queued
		if s.SourceEnd <= s.SourceStart {
			continue
		}
		start := int64(math.Round(s.TimelineStart * 48000))
		end := min(total, int64(math.Round((s.TimelineStart+(s.SourceEnd-s.SourceStart)/speed)*48000)))
		// Validation permits only <=1ms overlaps from rounding; retain exact
		// subsequent timeline positions by trimming that tiny leading overlap.
		start = max(start, cursor)
		if end <= start {
			continue
		}
		silence(start - cursor)
		count := end - start
		key := audioRenderSourceKey(s)
		if sources[key].HasAudio && !s.Muted {
			sourceStart := s.SourceStart + math.Max(0, float64(start)/48000-s.TimelineStart)*speed
			tempo := ""
			align := ",aresample=48000:first_pts=0"
			if speed != 1 {
				tempo = fmt.Sprintf(",atempo=%.9f", speed)
				// atempo preserves the initial PTS but transforms sample duration.
				// Scale only that origin, not the already tempo-adjusted samples.
				align = fmt.Sprintf(",asetpts=PTS-STARTPTS+STARTPTS/%.9f,aresample=48000:first_pts=0", speed)
			}
			gain := ""
			if s.Volume != nil && *s.Volume != 1 {
				gain = fmt.Sprintf(",volume=%.9f", *s.Volume)
			}
			// Anchor to the requested source time, not the first available audio
			// frame. Keep the source offset in PTS through atempo, then pad its
			// scaled origin. Feeding silence through WSOLA would distort its length.
			appendPart(fmt.Sprintf("[%d:a:0]atrim=start=%.9f:end=%.9f,asetpts=PTS-%.9f/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo%s%s%s,apad=whole_len=%d,atrim=end_sample=%d,asetpts=PTS-STARTPTS", indexes[key], sourceStart, s.SourceEnd, sourceStart, tempo, align, gain, count, count))
		} else {
			silence(count)
		}
		cursor = end
	}
	silence(total - cursor)
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=0:a=1,apad=whole_len=%d,atrim=end_sample=%d,asetpts=PTS-STARTPTS[%s]", labels.String(), parts, total, total, output))
	return filters
}
