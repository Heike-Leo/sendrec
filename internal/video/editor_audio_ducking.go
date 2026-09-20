package video

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Keep this contract identical to editorAudioDucking.ts: fades are inside
// merged voice-over windows, shortened to half the window for short segments.
const originalAudioDuckingGain = 0.25
const audioDuckingFadeSeconds = 0.2

type audioDuckingWindow struct{ start, end float64 }

func audioDuckingWindows(timeline editTimeline) []audioDuckingWindow {
	var windows []audioDuckingWindow
	for _, segment := range renderAudioSegments(timeline.Clips, timeline.AudioSegments) {
		if audioTrackID(segment) != "voiceover-1" || segment.Muted {
			continue
		}
		speed, err := effectiveRenderAudioSpeed(segment, timeline.Clips)
		if err != nil { // Render validation rejects invalid geometry before this stage.
			continue
		}
		end := segment.TimelineStart + (segment.SourceEnd-segment.SourceStart)/speed
		if end > segment.TimelineStart {
			windows = append(windows, audioDuckingWindow{segment.TimelineStart, end})
		}
	}
	sort.SliceStable(windows, func(i, j int) bool { return windows[i].start < windows[j].start })
	var merged []audioDuckingWindow
	for _, window := range windows {
		if n := len(merged); n > 0 && window.start <= merged[n-1].end {
			merged[n-1].end = math.Max(merged[n-1].end, window.end)
		} else {
			merged = append(merged, window)
		}
	}
	return merged
}

func audioDuckingExpression(windows []audioDuckingWindow) string {
	expression := "1"
	for i := len(windows) - 1; i >= 0; i-- {
		w := windows[i]
		fade := math.Min(audioDuckingFadeSeconds, (w.end-w.start)/2)
		expression = fmt.Sprintf("if(gte(t,%.9f)*lt(t,%.9f),1-%.9f*min(1,min((t-%.9f)/%.9f,(%.9f-t)/%.9f)),%s)",
			w.start, w.end, 1-originalAudioDuckingGain, w.start, fade, w.end, fade, expression)
	}
	return expression
}

// The established builder has already applied source offsets, speed, volume,
// mute, gaps and exact duration to each stereo/48-kHz track. Only multiply the
// original track before amix. aeval evaluates per sample, not per audio frame.
// All video/overlay arguments and the voice-over track remain untouched.
func applyTimelineDucking(args []string, timeline editTimeline) []string {
	if timeline.DuckOriginalAudio == nil || !*timeline.DuckOriginalAudio {
		return args
	}
	windows := audioDuckingWindows(timeline)
	if len(windows) == 0 {
		return args
	}
	const mix = "[mix0][mix1]amix="
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "-filter_complex" || !strings.Contains(args[i+1], mix) {
			continue // Original-only / voice-over-only graphs need no ducking.
		}
		gain := audioDuckingExpression(windows)
		// Two expressions alone can negotiate an unnamed "2 channels" layout
		// through concat/amix. AAC requires the explicit stereo speaker layout.
		filter := fmt.Sprintf("[mix0]aeval=exprs='val(0)*(%s)|val(1)*(%s)':channel_layout=stereo,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[duckedOriginal];[duckedOriginal][mix1]amix=", gain, gain)
		result := append([]string(nil), args...)
		result[i+1] = strings.Replace(args[i+1], mix, filter, 1)
		return result
	}
	return args
}
