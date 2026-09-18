package video

import (
	"image"
	"image/color"
	"math"
	"strconv"
)

// Canonical output pixels; preview scales this with the displayed frame.
const editorLineStroke = 3.0

func lineEndpoints(a editorAnnotation, width, height int) (arrowPoint, arrowPoint) {
	sin, cos := math.Sincos(a.Rotation * math.Pi / 180)
	point := func(offset float64) arrowPoint {
		// Preview: (8,50)-(92,50), rotate in 100x100, then viewport scaling.
		return arrowPoint{(a.X + a.Width*(.5+offset*cos)) * float64(width) / 100,
			(a.Y + a.Height*(.5+offset*sin)) * float64(height) / 100}
	}
	return point(-.42), point(.42)
}

func rasterLine(a editorAnnotation, width, height int) *image.NRGBA {
	stroke := editorLineStroke
	if a.StrokeWidth != nil {
		stroke = *a.StrokeWidth
	}
	bounds := arrowBounds(a, width, height)
	img := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	p, q := lineEndpoints(a, width, height)
	dx, dy := q.x-p.x, q.y-p.y
	lengthSquared := dx*dx + dy*dy
	hex := a.Color
	if hex == "" {
		hex = "#FC2667"
	}
	rgb, _ := strconv.ParseUint(hex[1:], 16, 24) // validated before rasterization
	distance := func(x, y float64) float64 {
		t := 0.
		if lengthSquared > 0 {
			t = math.Max(0, math.Min(1, ((x-p.x)*dx+(y-p.y)*dy)/lengthSquared))
		}
		return math.Hypot(x-p.x-t*dx, y-p.y-t*dy)
	}
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			px, py := float64(bounds.Min.X+x), float64(bounds.Min.Y+y)
			if distance(px+.5, py+.5) > stroke/2+1 {
				continue
			}
			covered := 0
			for sy := 0; sy < 4; sy++ {
				for sx := 0; sx < 4; sx++ {
					if distance(px+(float64(sx)+.5)/4, py+(float64(sy)+.5)/4) <= stroke/2 {
						covered++
					}
				}
			}
			if covered > 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(rgb >> 16), uint8(rgb >> 8), uint8(rgb), uint8((covered*255 + 8) / 16)})
			}
		}
	}
	return img
}
