package video

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Match the existing source-duration tolerance: at most one millisecond.
const editorAudioTolerance = .001

func renderAudioSegments(clips []editClip, stored *[]editorAudioSegment) []editorAudioSegment {
	if stored != nil {
		return append([]editorAudioSegment{}, (*stored)...)
	}
	segments := make([]editorAudioSegment, 0, len(clips))
	offset := 0.0
	for _, clip := range clips {
		segments = append(segments, editorAudioSegment{ID: "audio:" + clip.ID, SourceClipID: clip.ID,
			SourceVideoID: clip.SourceID, SourceStart: clip.SourceStart, SourceEnd: clip.SourceEnd, TimelineStart: offset})
		offset += clip.SourceEnd - clip.SourceStart
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
		add(segment.SourceVideoID)
	}
	return ids
}

func validateRenderAudio(timeline editTimeline, sources map[string]sourceVideo) error {
	duration := 0.0
	for _, clip := range timeline.Clips {
		duration += clip.SourceEnd - clip.SourceStart
	}
	segments := renderAudioSegments(timeline.Clips, timeline.AudioSegments)
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].TimelineStart < segments[j].TimelineStart })
	end := 0.0
	for _, s := range segments {
		for _, v := range []float64{s.SourceStart, s.SourceEnd, s.TimelineStart} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return fmt.Errorf("audio segment times must be finite")
			}
		}
		if s.SourceStart < 0 || s.SourceEnd < s.SourceStart || s.TimelineStart < 0 {
			return fmt.Errorf("audio segment time range is invalid")
		}
		source, ok := sources[s.SourceVideoID]
		if !ok {
			return fmt.Errorf("audio segment references an unavailable source")
		}
		if s.SourceEnd > float64(source.Duration)+editorAudioTolerance {
			return fmt.Errorf("audio segment exceeds source duration")
		}
		segmentEnd := s.TimelineStart + s.SourceEnd - s.SourceStart
		if segmentEnd > duration+editorAudioTolerance {
			return fmt.Errorf("audio segment exceeds timeline duration")
		}
		if s.SourceEnd == s.SourceStart {
			continue
		}
		if s.TimelineStart < end-editorAudioTolerance {
			return fmt.Errorf("audio segments must not overlap")
		}
		end = math.Max(end, segmentEnd)
	}
	return nil
}

// One sequential track, no mixing and no implicit clip audio. Boundaries are
// rounded to 48-kHz sample positions to avoid cumulative per-segment drift.
func timelineAudioFilters(clips []editClip, stored *[]editorAudioSegment, indexes map[string]int, sources map[string]sourceVideo) []string {
	segments := renderAudioSegments(clips, stored)
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].TimelineStart < segments[j].TimelineStart })
	duration := 0.0
	for _, clip := range clips {
		duration += clip.SourceEnd - clip.SourceStart
	}
	total := int64(math.Round(duration * 48000))
	var filters []string
	var labels strings.Builder
	parts := 0
	appendPart := func(filter string) {
		label := fmt.Sprintf("at%d", parts)
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
		if s.SourceEnd <= s.SourceStart {
			continue
		}
		start := int64(math.Round(s.TimelineStart * 48000))
		end := min(total, int64(math.Round((s.TimelineStart+s.SourceEnd-s.SourceStart)*48000)))
		// Validation permits only <=1ms overlaps from rounding; retain exact
		// subsequent timeline positions by trimming that tiny leading overlap.
		start = max(start, cursor)
		if end <= start {
			continue
		}
		silence(start - cursor)
		count := end - start
		if sources[s.SourceVideoID].HasAudio && !s.Muted {
			sourceStart := s.SourceStart + math.Max(0, float64(start)/48000-s.TimelineStart)
			appendPart(fmt.Sprintf("[%d:a:0]atrim=start=%.9f:end=%.9f,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=%d,atrim=end_sample=%d,asetpts=PTS-STARTPTS", indexes[s.SourceVideoID], sourceStart, s.SourceEnd, count, count))
		} else {
			silence(count)
		}
		cursor = end
	}
	silence(total - cursor)
	filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=0:a=1,apad=whole_len=%d,atrim=end_sample=%d,asetpts=PTS-STARTPTS[aout]", labels.String(), parts, total, total))
	return filters
}
