package video

import (
	"fmt"
	"math"
)

// Storage accepts future speeds; active rendering still requires nominal speed.
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
		speed, err := readClipSpeed(clip.Speed)
		if err != nil {
			return err
		}
		if speed != 1 {
			return fmt.Errorf("clip speed other than 1.0 is not supported yet")
		}
	}
	return nil
}
