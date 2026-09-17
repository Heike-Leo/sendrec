package video

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	editorTextAnnotationMinFontSize = 8
	editorTextAnnotationMaxFontSize = 256
	editorTextAnnotationMaxLength   = 120
	editorTextAnnotationMinBoxSize  = 1
)

// Preserve the existing shape JSON contract; text has no rotation or symbol.
func (a editorAnnotation) MarshalJSON() ([]byte, error) {
	type plain editorAnnotation
	if a.Type != "text" {
		return json.Marshal(plain(a))
	}
	return json.Marshal(struct {
		plain
		Rotation *float64 `json:"rotation,omitempty"`
		Symbol   *string  `json:"symbol,omitempty"`
	}{plain: plain(a)})
}

func validateTextAnnotation(a editorAnnotation, duration float64) error {
	if a.FontFamily != nil && *a.FontFamily != "dejavu-sans" && *a.FontFamily != "dejavu-serif" && *a.FontFamily != "dejavu-mono" {
		return fmt.Errorf("invalid text font family")
	}
	visible := false
	if !utf8.ValidString(a.Text) || utf8.RuneCountInString(a.Text) > editorTextAnnotationMaxLength {
		return fmt.Errorf("invalid annotation text")
	}
	for _, r := range a.Text {
		if r != '\n' && unicode.IsControl(r) {
			return fmt.Errorf("invalid annotation text")
		}
		visible = visible || unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsPunct(r) || unicode.IsSymbol(r)
	}
	if !visible || strings.TrimSpace(a.ID) == "" {
		return fmt.Errorf("invalid annotation text")
	}
	for _, v := range []float64{a.X, a.Y, a.Width, a.Height, a.Start, a.End, a.FontSize} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("text annotation values must be finite")
		}
	}
	if a.X < 0 || a.Y < 0 || a.Width < editorTextAnnotationMinBoxSize || a.Height < editorTextAnnotationMinBoxSize || a.X+a.Width > 100 || a.Y+a.Height > 100 {
		return fmt.Errorf("invalid text box")
	}
	if a.FontSize < editorTextAnnotationMinFontSize || a.FontSize > editorTextAnnotationMaxFontSize {
		return fmt.Errorf("invalid text font size")
	}
	if a.Start < 0 || a.End <= a.Start || a.End > duration+0.001 {
		return fmt.Errorf("invalid text time range")
	}
	if a.Color != "" && !isEditorCoverColor(a.Color) {
		return fmt.Errorf("invalid text color")
	}
	if a.Rotation != 0 || a.Symbol != "" {
		return fmt.Errorf("text annotations do not support rotation or symbols")
	}
	return nil
}

func validateRenderAnnotations(annotations []editorAnnotation) error {
	for _, a := range annotations {
		if a.Type != "text" && a.Type != "arrow" && a.Type != "circle" && a.Type != "symbol" && a.Type != "line" {
			return fmt.Errorf("unknown annotation type")
		}
	}
	return nil
}
