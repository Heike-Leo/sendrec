package video

import (
	"image"
	"image/color"
	"math"
	"strconv"
)

// Coordinates mirror SymbolShape's 16x16 SVG. Curves are flattened at small
// angular intervals; round caps/joins are the union of radius-.75 segments.
type symbolSegment struct{ a, b arrowPoint }
type symbolDot struct {
	center arrowPoint
	radius float64
}
type symbolGeometry struct {
	lines []symbolSegment
	dots  []symbolDot
}

func (g *symbolGeometry) line(points ...arrowPoint) {
	for i := 1; i < len(points); i++ {
		g.lines = append(g.lines, symbolSegment{points[i-1], points[i]})
	}
}
func (g *symbolGeometry) arc(center arrowPoint, r, start, sweep float64) {
	n := int(math.Ceil(math.Abs(sweep) / (.025)))
	prev := arrowPoint{center.x + r*math.Cos(start), center.y + r*math.Sin(start)}
	for i := 1; i <= n; i++ {
		angle := start + sweep*float64(i)/float64(n)
		next := arrowPoint{center.x + r*math.Cos(angle), center.y + r*math.Sin(angle)}
		g.line(prev, next)
		prev = next
	}
}

// SVG circular A command, sweep=1. All local arcs use this direction.
func (g *symbolGeometry) svgArc(a, b arrowPoint, r float64, large bool) {
	dx, dy := b.x-a.x, b.y-a.y
	d := math.Hypot(dx, dy)
	h := math.Sqrt(math.Max(0, r*r-d*d/4))
	sign := 1.
	if large {
		sign = -1
	}
	c := arrowPoint{(a.x+b.x)/2 - sign*dy*h/d, (a.y+b.y)/2 + sign*dx*h/d}
	start := math.Atan2(a.y-c.y, a.x-c.x)
	sweep := math.Mod(math.Atan2(b.y-c.y, b.x-c.x)-start+2*math.Pi, 2*math.Pi)
	g.arc(c, r, start, sweep)
}
func (g *symbolGeometry) cubic(a, b, c, d arrowPoint) {
	prev := a
	for i := 1; i <= 80; i++ {
		t := float64(i) / 80
		u := 1 - t
		p := arrowPoint{u*u*u*a.x + 3*u*u*t*b.x + 3*u*t*t*c.x + t*t*t*d.x, u*u*u*a.y + 3*u*u*t*b.y + 3*u*t*t*c.y + t*t*t*d.y}
		g.line(prev, p)
		prev = p
	}
}
func symbolShape(id string) symbolGeometry {
	var g symbolGeometry
	dot := func(x, y float64) { g.dots = append(g.dots, symbolDot{arrowPoint{x, y}, 1.15}) } // .4 fill + .75 stroke
	switch id {
	case "check":
		g.line(arrowPoint{3, 8}, arrowPoint{6, 11}, arrowPoint{13, 4})
	case "cross":
		g.line(arrowPoint{3, 3}, arrowPoint{13, 13})
		g.line(arrowPoint{13, 3}, arrowPoint{3, 13})
	case "warning":
		g.line(arrowPoint{8, 2}, arrowPoint{14, 13}, arrowPoint{2, 13}, arrowPoint{8, 2})
		g.line(arrowPoint{8, 6}, arrowPoint{8, 9})
		dot(8, 11)
	case "info":
		g.arc(arrowPoint{8, 8}, 6, 0, 2*math.Pi)
		g.line(arrowPoint{8, 7}, arrowPoint{8, 11})
		dot(8, 5)
	case "star":
		g.line(arrowPoint{8, 2}, arrowPoint{9.8, 5.8}, arrowPoint{14, 6.4}, arrowPoint{11, 9.4}, arrowPoint{11.7, 13.6}, arrowPoint{8, 11.6}, arrowPoint{4.3, 13.6}, arrowPoint{5, 9.4}, arrowPoint{2, 6.4}, arrowPoint{6.2, 5.8}, arrowPoint{8, 2})
	case "plus":
		g.line(arrowPoint{8, 3}, arrowPoint{8, 13})
		g.line(arrowPoint{3, 8}, arrowPoint{13, 8})
	case "question":
		g.arc(arrowPoint{8, 8}, 6, 0, 2*math.Pi)
		g.svgArc(arrowPoint{6, 6}, arrowPoint{9, 7.7}, 2, true)
		g.cubic(arrowPoint{9, 7.7}, arrowPoint{8, 8.2}, arrowPoint{8, 8.5}, arrowPoint{8, 9})
		dot(8, 11)
	case "pointer":
		g.line(arrowPoint{6, 8}, arrowPoint{6, 3})
		g.svgArc(arrowPoint{6, 3}, arrowPoint{8, 3}, 1, false)
		g.line(arrowPoint{8, 3}, arrowPoint{8, 7}, arrowPoint{8, 6})
		g.svgArc(arrowPoint{8, 6}, arrowPoint{10, 6}, 1, false)
		g.line(arrowPoint{10, 6}, arrowPoint{10, 7})
		g.svgArc(arrowPoint{10, 7}, arrowPoint{12, 7}, 1, false)
		g.line(arrowPoint{12, 7}, arrowPoint{12, 8})
		g.svgArc(arrowPoint{12, 8}, arrowPoint{14, 8}, 1, false)
		g.line(arrowPoint{14, 8}, arrowPoint{14, 10})
		g.cubic(arrowPoint{14, 10}, arrowPoint{14, 12}, arrowPoint{12, 14}, arrowPoint{10, 14})
		g.line(arrowPoint{10, 14}, arrowPoint{8, 14})
		g.cubic(arrowPoint{8, 14}, arrowPoint{6, 14}, arrowPoint{5, 12}, arrowPoint{4, 11})
		g.line(arrowPoint{4, 11}, arrowPoint{2, 9})
		g.svgArc(arrowPoint{2, 9}, arrowPoint{3.5, 7.7}, 1, false)
		g.line(arrowPoint{3.5, 7.7}, arrowPoint{6, 10})
	}
	return g
}

func (g symbolGeometry) contains(p arrowPoint) bool {
	for _, d := range g.dots {
		if math.Hypot(p.x-d.center.x, p.y-d.center.y) <= d.radius {
			return true
		}
	}
	for _, s := range g.lines {
		dx, dy := s.b.x-s.a.x, s.b.y-s.a.y
		t := math.Max(0, math.Min(1, ((p.x-s.a.x)*dx+(p.y-s.a.y)*dy)/(dx*dx+dy*dy)))
		x, y := p.x-s.a.x-t*dx, p.y-s.a.y-t*dy
		if x*x+y*y <= .75*.75 {
			return true
		}
	}
	return false
}

// Same inverse transform as the preview: translate(18,18), scale(4),
// rotate about (50,50), then non-uniform scaling to the video rectangle.
func rasterSymbol(a editorAnnotation, width, height int) *image.NRGBA {
	bounds := arrowBounds(a, width, height)
	img := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	g := symbolShape(a.Symbol)
	hex := a.Color
	if hex == "" {
		hex = "#FC2667"
	}
	rgb, _ := strconv.ParseUint(hex[1:], 16, 24) // validated by prepareArrowFiles
	sin, cos := math.Sincos(a.Rotation * math.Pi / 180)
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			count := 0
			for sy := 0; sy < 2; sy++ {
				for sx := 0; sx < 2; sx++ {
					px := ((float64(bounds.Min.X+x)+(float64(sx)+.5)/2)/float64(width)*100-a.X)/a.Width*100 - 50
					py := ((float64(bounds.Min.Y+y)+(float64(sy)+.5)/2)/float64(height)*100-a.Y)/a.Height*100 - 50
					if g.contains(arrowPoint{(px*cos + py*sin + 32) / 4, (-px*sin + py*cos + 32) / 4}) {
						count++
					}
				}
			}
			if count > 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(rgb >> 16), uint8(rgb >> 8), uint8(rgb), uint8(math.Round(float64(count) * 255 / 4))})
			}
		}
	}
	return img
}
