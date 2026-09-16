package video

import (
	"fmt"
	"math"
)

// Shared speed contract for storage and rendering.
func readClipSpeed(speed *float64) (float64, error) {
	if speed == nil {
		return 1, nil
	}
	if math.IsNaN(*speed) || math.IsInf(*speed, 0) || *speed < 0.5 || *speed > 2 {
		return 0, fmt.Errorf("clip speed must be finite and between 0.5 and 2.0")
	}
	return *speed, nil
}

func validateRenderClipSpeeds(clips []editClip) error {
	for _, clip := range clips {
		_, err := readClipSpeed(clip.Speed)
		if err != nil {
			return err
		}
	}
	return nil
}

// Callers validate speeds before constructing a render graph.
func clipTimelineDuration(clip editClip) float64 {
	speed, _ := readClipSpeed(clip.Speed)
	return (clip.SourceEnd - clip.SourceStart) / speed
}
