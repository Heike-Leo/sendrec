package video

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// The existing timeline pipeline scales/pads every source to this output size.
const editorRenderWidth, editorRenderHeight = 1920, 1080

type arrowPoint struct{ x, y float64 }

func arrowBounds(a editorAnnotation, width, height int) image.Rectangle {
	return image.Rect(int(math.Floor(a.X*float64(width)/100)), int(math.Floor(a.Y*float64(height)/100)),
		int(math.Ceil((a.X+a.Width)*float64(width)/100)), int(math.Ceil((a.Y+a.Height)*float64(height)/100))).Intersect(image.Rect(0, 0, width, height))
}

func arrowVertices(a editorAnnotation, width, height int) []arrowPoint {
	// Same polygon and transform order as the preview SVG: rotate in its
	// 100x100 viewBox, THEN scale (preserveAspectRatio="none") and translate.
	points := []arrowPoint{{8, 44}, {65, 44}, {65, 28}, {94, 50}, {65, 72}, {65, 56}, {8, 56}}
	sin, cos := math.Sincos(a.Rotation * math.Pi / 180)
	for i, p := range points {
		x, y := p.x-50, p.y-50
		points[i] = arrowPoint{
			(a.X + (50+x*cos-y*sin)*a.Width/100) * float64(width) / 100,
			(a.Y + (50+x*sin+y*cos)*a.Height/100) * float64(height) / 100,
		}
	}
	return points
}

// Scanline rasterization with four subpixel rows and fractional horizontal
// coverage keeps edges antialiased without a SVG renderer or font dependency.
// Callers validate the timeline before allocating any surfaces.
func rasterArrow(a editorAnnotation, width, height int) *image.NRGBA {
	bounds := arrowBounds(a, width, height)
	img := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	points := arrowVertices(a, width, height)
	hex := a.Color
	if hex == "" {
		hex = "#FC2667"
	}
	rgb, _ := strconv.ParseUint(hex[1:], 16, 24) // validated six-digit hex
	coverage := make([]float64, bounds.Dx())
	for y := 0; y < bounds.Dy(); y++ {
		clear(coverage)
		for sample := 0; sample < 4; sample++ {
			py := float64(bounds.Min.Y+y) + (float64(sample)+0.5)/4
			var crossings []float64
			for i, p := range points {
				q := points[(i+1)%len(points)]
				if (p.y <= py && q.y > py) || (q.y <= py && p.y > py) {
					crossings = append(crossings, p.x+(py-p.y)*(q.x-p.x)/(q.y-p.y)-float64(bounds.Min.X))
				}
			}
			sort.Float64s(crossings)
			for i := 0; i+1 < len(crossings); i += 2 {
				left, right := math.Max(0, crossings[i]), math.Min(float64(bounds.Dx()), crossings[i+1])
				for x := int(math.Floor(left)); x < int(math.Ceil(right)); x++ {
					coverage[x] += math.Max(0, math.Min(right, float64(x+1))-math.Max(left, float64(x))) / 4
				}
			}
		}
		for x, alpha := range coverage {
			if alpha > 0 {
				img.SetNRGBA(x, y, color.NRGBA{uint8(rgb >> 16), uint8(rgb >> 8), uint8(rgb), uint8(math.Round(math.Min(1, alpha) * 255))})
			}
		}
	}
	return img
}

func arrowFilename(index int) string { return fmt.Sprintf("arrow-%d.png", index) }

// Circles are persisted preview-only annotations; do not export them as arrows.
func exportArrowAnnotations(annotations []editorAnnotation) []editorAnnotation {
	var arrows []editorAnnotation
	for _, annotation := range annotations {
		if annotation.Type == "arrow" {
			arrows = append(arrows, annotation)
		}
	}
	return arrows
}

func prepareArrowFiles(dir string, timeline editTimeline) error {
	if len(timeline.Annotations) == 0 {
		return nil
	}
	if err := validateEditTimeline(&timeline); err != nil {
		return err
	}
	for i, a := range exportArrowAnnotations(timeline.Annotations) {
		f, err := os.OpenFile(filepath.Join(dir, arrowFilename(i)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return fmt.Errorf("prepare arrow: %w", err)
		}
		err = png.Encode(f, rasterArrow(a, editorRenderWidth, editorRenderHeight))
		closeErr := f.Close()
		if err != nil {
			return fmt.Errorf("encode arrow: %w", err)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// Extend, rather than replace, the established cover/blur/text graph. Empty
// annotations return byte-for-byte identical arguments. Generated filenames
// contain neither annotation IDs nor user input; no shell is involved.
func buildAnnotatedTimelineRenderArgs(inputs []string, clips []editClip, indexes map[string]int, sources map[string]sourceVideo, output string, overlays []editorCoverOverlay, annotations []editorAnnotation) []string {
	annotations = exportArrowAnnotations(annotations)
	args := buildTimelineRenderArgs(inputs, clips, indexes, sources, output, overlays)
	if len(annotations) == 0 {
		return args
	}
	filterIndex := 0
	for args[filterIndex] != "-filter_complex" {
		filterIndex++
	}
	graph := strings.ReplaceAll(args[filterIndex+1], "[vout]", "[varrowbase]")
	result := append([]string{}, args[:filterIndex]...)
	previous := "varrowbase"
	for i, a := range annotations {
		result = append(result, "-loop", "1", "-framerate", "30", "-i", arrowFilename(i))
		bounds := arrowBounds(a, editorRenderWidth, editorRenderHeight)
		next := fmt.Sprintf("varrow%d", i)
		if i == len(annotations)-1 {
			next = "vout"
		}
		// RGB composition preserves exact pixel placement, including odd x/y,
		// before the final yuv420p conversion required by the existing encoder.
		graph += fmt.Sprintf(";[%s][%d:v]overlay=x=%d:y=%d:format=rgb:shortest=1:enable='between(t,%.6f,%.6f)'[%s]",
			previous, len(inputs)+i, bounds.Min.X, bounds.Min.Y, a.Start, a.End, next+"rgb")
		previous = next + "rgb"
	}
	graph += fmt.Sprintf(";[%s]format=yuv420p[vout]", previous)
	result = append(result, "-filter_complex", graph)
	return append(result, args[filterIndex+2:]...)
}
