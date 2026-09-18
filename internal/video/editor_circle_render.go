package video

import (
	"image"
	"image/color"
	"math"
	"strconv"
)

// Canonical output pixels; preview scales this with the displayed frame.
const editorCircleStroke = 3.0

func rasterCircle(a editorAnnotation, width, height int) *image.NRGBA {
	stroke := editorCircleStroke
	if a.StrokeWidth != nil {
		stroke = *a.StrokeWidth
	}
	bounds := arrowBounds(a, width, height) // shared percentage/frame geometry
	img := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	w, h := a.Width*float64(width)/100, a.Height*float64(height)/100
	cx := (a.X+a.Width/2)*float64(width)/100 - float64(bounds.Min.X)
	cy := (a.Y+a.Height/2)*float64(height)/100 - float64(bounds.Min.Y)
	// Match SVG ellipse cx/cy=50 and rx/ry=47, with no rotation or fill.
	rx, ry := .47*w, .47*h
	hex := a.Color
	if hex == "" {
		hex = "#FC2667"
	}
	rgb, _ := strconv.ParseUint(hex[1:], 16, 24) // validated by prepareArrowFiles
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			// Conservative lower bound avoids supersampling the empty interior.
			q := math.Hypot((float64(x)+.5-cx)/rx, (float64(y)+.5-cy)/ry)
			if math.Abs(q-1)*math.Min(rx, ry) > stroke/2+1 {
				continue
			}
			covered := 0
			for sy := 0; sy < 4; sy++ {
				for sx := 0; sx < 4; sx++ {
					dx, dy := float64(x)+(float64(sx)+.5)/4-cx, float64(y)+(float64(sy)+.5)/4-cy
					q := math.Hypot(dx/rx, dy/ry)
					if q == 0 {
						continue
					}
					// First-order distance to the ellipse gives a thin, uniform
					// pixel contour even for non-square viewports (SVG vector-effect).
					gradient := math.Hypot(dx/(rx*rx), dy/(ry*ry)) / q
					if math.Abs(q-1)/gradient <= stroke/2 {
						covered++
					}
				}
			}
			if covered != 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(rgb >> 16), uint8(rgb >> 8), uint8(rgb), uint8((covered*255 + 8) / 16)})
			}
		}
	}
	return img
}
