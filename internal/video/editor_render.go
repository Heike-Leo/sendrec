package video

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sendrec/sendrec/internal/httputil"
)

const editTimelineVersion = 1
const editorBlurSigma = 12
const editorTextFont = "/usr/share/fonts/dejavu/DejaVuSans.ttf"
const editorTextFontSize = 32 // Fixed size for the existing 1920x1080 render target.

type editClip struct {
	Speed       *float64 `json:"speed,omitempty"`
	ID          string   `json:"id"`
	SourceID    string   `json:"sourceId"`
	SourceStart float64  `json:"sourceStart"`
	SourceEnd   float64  `json:"sourceEnd"`
	Duration    float64  `json:"duration"`
}

type editorCoverOverlay struct {
	ID      string   `json:"id"`
	X       float64  `json:"x"`
	Y       float64  `json:"y"`
	Width   float64  `json:"width"`
	Height  float64  `json:"height"`
	Start   float64  `json:"start"`
	End     float64  `json:"end"`
	Mode    string   `json:"mode,omitempty"`
	Color   string   `json:"color,omitempty"`
	Opacity *float64 `json:"opacity,omitempty"`
	Text    string   `json:"text,omitempty"`
}

// Shapes are rendered; text is persisted but explicitly render-gated for now.
type editorAnnotation struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Symbol     string   `json:"symbol,omitempty"`
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	Width      float64  `json:"width"`
	Height     float64  `json:"height"`
	Start      float64  `json:"start"`
	End        float64  `json:"end"`
	Rotation   float64  `json:"rotation"`
	ShaftWidth *float64 `json:"shaftWidth,omitempty"`
	Color      string   `json:"color,omitempty"`
	Text       string   `json:"text,omitempty"`
	FontSize   float64  `json:"fontSize,omitempty"`
	FontFamily *string  `json:"fontFamily,omitempty"`
	Bold       *bool    `json:"bold,omitempty"`
	Italic     *bool    `json:"italic,omitempty"`
}

type editorAudioSegment struct {
	Speed          *float64 `json:"speed,omitempty"`
	GeometryLinked *bool    `json:"geometryLinked,omitempty"`
	Volume         *float64 `json:"volume,omitempty"`
	Muted          bool     `json:"muted"`
	ID             string   `json:"id"`
	SourceClipID   string   `json:"sourceClipId"`
	SourceVideoID  string   `json:"sourceVideoId"`
	SourceStart    float64  `json:"sourceStart"`
	SourceEnd      float64  `json:"sourceEnd"`
	TimelineStart  float64  `json:"timelineStart"`
}

type editTimeline struct {
	AudioSegments *[]editorAudioSegment `json:"audioSegments,omitempty"`
	Version       int                   `json:"version"`
	Clips         []editClip            `json:"clips"`
	Overlays      []editorCoverOverlay  `json:"overlays,omitempty"`
	Annotations   []editorAnnotation    `json:"annotations,omitempty"`
}

type editorStateResponse struct {
	Timeline      editTimeline `json:"timeline"`
	RenderStatus  string       `json:"renderStatus"`
	RenderError   *string      `json:"renderError"`
	RenderedVideo *string      `json:"renderedVideoId"`
}

type sourceVideo struct {
	ID          string
	FileKey     string
	ContentType string
	Duration    int
	HasAudio    bool
}

type renderJob struct {
	SourceVideoID  string
	OwnerID        string
	OrganizationID *string
	Title          string
	Timeline       editTimeline
	Sources        map[string]sourceVideo
}

var enqueueTimelineRender = func(h *Handler, job renderJob) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		h.renderTimelineAsync(ctx, job)
	}()
}

func validateEditTimeline(timeline *editTimeline) error {
	if timeline.Version == 0 {
		timeline.Version = editTimelineVersion
	}
	if timeline.Version != editTimelineVersion {
		return fmt.Errorf("unsupported timeline version")
	}
	if len(timeline.Clips) == 0 {
		return fmt.Errorf("timeline must contain at least one clip")
	}
	if len(timeline.Clips) > 500 {
		return fmt.Errorf("timeline contains too many clips")
	}
	seen := make(map[string]struct{}, len(timeline.Clips))
	totalDuration := 0.0
	for i := range timeline.Clips {
		clip := &timeline.Clips[i]
		if _, err := readClipSpeed(clip.Speed); err != nil {
			return err
		}
		if strings.TrimSpace(clip.ID) == "" || strings.TrimSpace(clip.SourceID) == "" {
			return fmt.Errorf("clip id and sourceId are required")
		}
		if _, exists := seen[clip.ID]; exists {
			return fmt.Errorf("clip ids must be unique")
		}
		seen[clip.ID] = struct{}{}
		if math.IsNaN(clip.SourceStart) || math.IsInf(clip.SourceStart, 0) || math.IsNaN(clip.SourceEnd) || math.IsInf(clip.SourceEnd, 0) || clip.SourceStart < 0 || clip.SourceEnd <= clip.SourceStart {
			return fmt.Errorf("clip sourceEnd must be greater than sourceStart")
		}
		clip.Duration = clipTimelineDuration(*clip)
		totalDuration += clip.Duration
	}
	if totalDuration < 1 {
		return fmt.Errorf("timeline must be at least one second long")
	}
	if timeline.AudioSegments != nil {
		if len(*timeline.AudioSegments) > 500 {
			return fmt.Errorf("timeline contains too many audio segments")
		}
		ids := make(map[string]bool)
		for _, segment := range *timeline.AudioSegments {
			if _, err := readAudioSpeed(segment.Speed); err != nil {
				return err
			}
			if err := validateAudioVolume(segment.Volume); err != nil {
				return err
			}
			if strings.TrimSpace(segment.ID) == "" || ids[segment.ID] || strings.TrimSpace(segment.SourceClipID) == "" || strings.TrimSpace(segment.SourceVideoID) == "" {
				return fmt.Errorf("audio segment requires unique id and source references")
			}
			ids[segment.ID] = true
			for _, value := range []float64{segment.SourceStart, segment.SourceEnd, segment.TimelineStart} {
				if math.IsNaN(value) || math.IsInf(value, 0) {
					return fmt.Errorf("audio segment times must be finite")
				}
			}
			if segment.SourceStart < 0 || segment.SourceEnd < segment.SourceStart || segment.TimelineStart < 0 {
				return fmt.Errorf("audio segment time range is invalid")
			}
		}
	}

	if len(timeline.Overlays) > 500 {
		return fmt.Errorf("timeline contains too many overlays")
	}
	if len(timeline.Annotations) > 500 {
		return fmt.Errorf("timeline contains too many annotations")
	}
	annotationIDs := make(map[string]bool, len(timeline.Annotations))
	for i := range timeline.Annotations {
		annotation := &timeline.Annotations[i]
		if strings.TrimSpace(annotation.ID) == "" || annotationIDs[annotation.ID] || (annotation.Type != "arrow" && annotation.Type != "circle" && annotation.Type != "symbol" && annotation.Type != "line" && annotation.Type != "text") {
			return fmt.Errorf("annotation requires a unique id and type arrow, circle, symbol, line or text")
		}
		if annotation.Type == "text" {
			annotationIDs[annotation.ID] = true
			if err := validateTextAnnotation(*annotation, totalDuration); err != nil {
				return err
			}
			continue
		}
		if annotation.Type == "symbol" {
			switch annotation.Symbol {
			case "check", "cross", "warning", "info", "star", "pointer", "plus", "question":
			default:
				return fmt.Errorf("invalid annotation symbol")
			}
		}
		annotationIDs[annotation.ID] = true
		if annotation.Type == "arrow" && annotation.ShaftWidth != nil {
			v := *annotation.ShaftWidth
			if math.IsNaN(v) || math.IsInf(v, 0) || v < 6 || v > 24 {
				return fmt.Errorf("arrow shaft width must be between 6 and 24")
			}
		}
		if annotation.Color != "" && !isEditorCoverColor(annotation.Color) {
			return fmt.Errorf("annotation color must be a six-digit hex color")
		}
		for _, value := range []float64{annotation.X, annotation.Y, annotation.Width, annotation.Height, annotation.Start, annotation.End, annotation.Rotation} {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return fmt.Errorf("annotation values must be finite")
			}
		}
		inside := annotation.X >= 0 && annotation.Y >= 0 && annotation.X+annotation.Width <= 100.001 && annotation.Y+annotation.Height <= 100.001
		if annotation.Type == "line" {
			// Lines may have an off-frame SVG viewport; only their endpoints are visible.
			a, b := lineEndpoints(*annotation, 100, 100)
			inside = true
			for _, p := range []arrowPoint{a, b} {
				inside = inside && p.x >= -0.001 && p.y >= -0.001 && p.x <= 100.001 && p.y <= 100.001
			}
		}
		if !inside || annotation.Width <= 0 || annotation.Height <= 0 {
			return fmt.Errorf("annotation must stay inside video bounds")
		}
		if annotation.Start < 0 || annotation.End <= annotation.Start || annotation.End > totalDuration+0.001 {
			return fmt.Errorf("annotation time range is invalid")
		}
		if annotation.Rotation < 0 || annotation.Rotation >= 360 {
			annotation.Rotation = math.Mod(math.Mod(annotation.Rotation, 360)+360, 360)
		}
	}

	overlayIDs := make(map[string]struct{}, len(timeline.Overlays))
	for i := range timeline.Overlays {
		overlay := &timeline.Overlays[i]
		if overlay.Mode == "" {
			overlay.Mode = "cover"
		}
		if overlay.Mode != "cover" && overlay.Mode != "blur" {
			return fmt.Errorf("overlay mode must be cover or blur")
		}
		if overlay.Color != "" && !isEditorCoverColor(overlay.Color) {
			return fmt.Errorf("overlay color must be a six-digit hex color")
		}
		if overlay.Opacity != nil && (*overlay.Opacity < 0.1 || *overlay.Opacity > 1) {
			return fmt.Errorf("overlay opacity must be between 0.1 and 1")
		}

		if strings.TrimSpace(overlay.ID) == "" {
			return fmt.Errorf("overlay id is required")
		}
		if _, exists := overlayIDs[overlay.ID]; exists {
			return fmt.Errorf("overlay ids must be unique")
		}
		overlayIDs[overlay.ID] = struct{}{}

		if overlay.X < 0 || overlay.Y < 0 ||
			overlay.Width <= 0 || overlay.Height <= 0 {
			return fmt.Errorf("overlay position and size are invalid")
		}

		if overlay.X+overlay.Width > 100.001 ||
			overlay.Y+overlay.Height > 100.001 {
			return fmt.Errorf("overlay must stay inside video bounds")
		}

		if overlay.Start < 0 || overlay.End <= overlay.Start {
			return fmt.Errorf("overlay end must be greater than start")
		}

		if overlay.End > totalDuration+0.001 {
			return fmt.Errorf("overlay exceeds timeline duration")
		}
	}

	return nil
}

func isEditorCoverColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, char := range color[1:] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func (h *Handler) GetEditorState(w http.ResponseWriter, r *http.Request) {
	videoID := chi.URLParam(r, "id")
	where, args := orgVideoFilter(r.Context(), videoID, nil, "AND status != 'deleted'")
	var raw []byte
	var status string
	var renderError, renderedVideoID *string
	err := h.db.QueryRow(r.Context(), `SELECT COALESCE(edit_timeline, 'null'::jsonb), edit_render_status,
		edit_render_error, edit_render_video_id::text FROM videos WHERE `+where, args...).
		Scan(&raw, &status, &renderError, &renderedVideoID)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	var timeline editTimeline
	if string(raw) != "null" {
		if err := json.Unmarshal(raw, &timeline); err != nil {
			httputil.WriteError(w, http.StatusInternalServerError, "stored timeline is invalid")
			return
		}
		for i := range timeline.Overlays {
			if timeline.Overlays[i].Mode == "" {
				timeline.Overlays[i].Mode = "cover"
			}
		}
	}
	httputil.WriteJSON(w, http.StatusOK, editorStateResponse{
		Timeline: timeline, RenderStatus: status, RenderError: renderError, RenderedVideo: renderedVideoID,
	})
}

func (h *Handler) SaveEditorTimeline(w http.ResponseWriter, r *http.Request) {
	videoID := chi.URLParam(r, "id")
	var timeline editTimeline
	if err := json.NewDecoder(r.Body).Decode(&timeline); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := validateEditTimeline(&timeline); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	raw, err := json.Marshal(timeline)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save timeline")
		return
	}
	where, args := orgVideoFilter(r.Context(), videoID, []any{json.RawMessage(raw)}, "AND status != 'deleted'")
	tag, err := h.db.Exec(r.Context(), `UPDATE videos SET edit_timeline = $1, updated_at = now() WHERE `+where, args...)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save timeline")
		return
	}
	if tag.RowsAffected() == 0 {
		httputil.WriteError(w, http.StatusNotFound, "video not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) RenderEditorTimeline(w http.ResponseWriter, r *http.Request) {
	videoID := chi.URLParam(r, "id")
	var request struct {
		editTimeline
		Title *string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if request.Title != nil && strings.TrimSpace(*request.Title) == "" {
		httputil.WriteError(w, http.StatusBadRequest, "video title must not be empty")
		return
	}
	timeline := request.editTimeline
	if err := validateEditTimeline(&timeline); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateRenderClipSpeeds(timeline.Clips); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateRenderAnnotations(timeline.Annotations); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateRenderAudioSpeeds(timeline.AudioSegments); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	where, args := orgVideoFilter(r.Context(), videoID, nil, "AND status = 'ready'")
	var job renderJob
	job.SourceVideoID = videoID
	err := h.db.QueryRow(r.Context(), `SELECT user_id, organization_id, title FROM videos WHERE `+where, args...).
		Scan(&job.OwnerID, &job.OrganizationID, &job.Title)
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "video not found or not ready")
		return
	}

	job.Timeline = timeline
	if request.Title == nil {
		job.Title += " (bearbeitet)" // Preserve legacy API clients.
	} else {
		job.Title = strings.TrimSpace(*request.Title)
	}
	job.Sources = make(map[string]sourceVideo)
	for _, sourceID := range renderSourceIDs(timeline) {
		sourceWhere, sourceArgs := orgVideoFilter(r.Context(), sourceID, nil, "AND status = 'ready'")
		var source sourceVideo
		source.ID = sourceID
		if err := h.db.QueryRow(r.Context(), `SELECT file_key, content_type, duration FROM videos WHERE `+sourceWhere, sourceArgs...).
			Scan(&source.FileKey, &source.ContentType, &source.Duration); err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "timeline contains an unavailable source")
			return
		}
		job.Sources[source.ID] = source
	}
	for _, clip := range timeline.Clips {
		if clip.SourceEnd > float64(job.Sources[clip.SourceID].Duration)+0.001 {
			httputil.WriteError(w, http.StatusBadRequest, "clip exceeds source duration")
			return
		}
	}

	if err := validateRenderAudio(timeline, job.Sources); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	raw, err := json.Marshal(timeline)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save timeline")
		return
	}
	updateWhere, updateArgs := orgVideoFilter(r.Context(), videoID, []any{json.RawMessage(raw)}, "AND edit_render_status != 'processing'")
	tag, err := h.db.Exec(r.Context(), `UPDATE videos SET edit_timeline = $1, edit_render_status = 'processing',
		edit_render_error = NULL, edit_render_video_id = NULL, updated_at = now() WHERE `+updateWhere, updateArgs...)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to save timeline")
		return
	}
	if tag.RowsAffected() == 0 {
		httputil.WriteError(w, http.StatusConflict, "timeline is already being rendered")
		return
	}

	enqueueTimelineRender(h, job)
	w.WriteHeader(http.StatusAccepted)
}

// Text surfaces are inset and raster-clipped to their cover. Tiny surfaces are
// omitted, just as in the preview. No editor badges/handles are exported.
func coverTextBounds(overlay editorCoverOverlay) (x, y, width, height int, visible bool) {
	if overlay.Mode == "blur" || overlay.Text == "" {
		return
	}
	x = int(math.Ceil(1920*overlay.X/100)) + 4
	y = int(math.Ceil(1080*overlay.Y/100)) + 4
	width = int(math.Floor(1920*(overlay.X+overlay.Width)/100)) - 4 - x
	height = int(math.Floor(1080*(overlay.Y+overlay.Height)/100)) - 4 - y
	visible = width >= 16 && height >= editorTextFontSize
	return
}

func coverTextFilename(index int) string {
	return fmt.Sprintf("cover-text-%d.txt", index)
}

// Only generated relative filenames enter the filtergraph. UTF-8 user text
// stays in private sidecars, with expansion=none; it is never filter/shell code.
// The FFmpeg command must run with Dir set to this render job's directory.
func prepareCoverTextFiles(dir string, overlays []editorCoverOverlay) error {
	for i, overlay := range overlays {
		if _, _, _, _, visible := coverTextBounds(overlay); !visible {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, coverTextFilename(i)), []byte(overlay.Text), 0600); err != nil {
			return fmt.Errorf("prepare cover text: %w", err)
		}
	}
	return nil
}

func buildTimelineRenderArgs(inputs []string, clips []editClip, sourceIndexes map[string]int, sources map[string]sourceVideo, output string, overlaySets ...[]editorCoverOverlay) []string {
	var overlays []editorCoverOverlay
	if len(overlaySets) > 0 {
		overlays = overlaySets[0]
	}
	return buildTimelineRenderArgsWithAudio(inputs, clips, sourceIndexes, sources, output, overlays, nil)
}

func buildTimelineRenderArgsWithAudio(inputs []string, clips []editClip, sourceIndexes map[string]int, sources map[string]sourceVideo, output string, overlays []editorCoverOverlay, audio *[]editorAudioSegment) []string {
	textCount := 0
	for _, overlay := range overlays {
		if _, _, _, _, visible := coverTextBounds(overlay); visible {
			textCount++
		}
	}
	args := make([]string, 0, len(inputs)*2+len(clips)*2+16)
	for _, input := range inputs {
		args = append(args, "-i", input)
	}
	var filters []string
	var concatInputs strings.Builder
	timelineDuration := 0.0
	for i, clip := range clips {
		duration := clipTimelineDuration(clip)
		timelineDuration += duration
		speed, _ := readClipSpeed(clip.Speed)
		pts := "PTS-STARTPTS"
		if speed != 1 {
			pts = fmt.Sprintf("(PTS-STARTPTS)/%.9f", speed)
		}
		inputIndex := sourceIndexes[clip.SourceID]
		// FPS conversion can leave the final decoded frame short of the clip's
		// duration. Clone that frame, then trim the padding to the original end.
		// Fit using display aspect ratio (including source SAR), not raster
		// aspect ratio. Round to the nearest even pixel for yuv420p, then mark
		// square pixels before padding. This avoids scale's rounding SAR being
		// propagated to concat, while preserving anamorphic display proportions.
		filters = append(filters, fmt.Sprintf(
			"[%d:v]trim=start=%.3f:end=%.3f,setpts=%s,scale=w='max(2,min(1920,round(1080*dar/2)*2))':h='max(2,min(1080,round(1920/dar/2)*2))',setsar=1,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop_mode=clone:stop_duration=%.9f,trim=duration=%.9f,format=yuv420p[v%d]",
			inputIndex, clip.SourceStart, clip.SourceEnd, pts, duration, duration, i))
		fmt.Fprintf(&concatInputs, "[v%d]", i)
	}
	filters = append(filters, timelineAudioFilters(clips, audio, sourceIndexes, sources)...)
	if len(overlays) == 0 {
		filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vout]", concatInputs.String(), len(clips)))
	} else {
		filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vbase]", concatInputs.String(), len(clips)))

		blurOverlays := make([]editorCoverOverlay, 0, len(overlays))
		coverOverlays := make([]editorCoverOverlay, 0, len(overlays))
		for _, overlay := range overlays {
			if overlay.Mode == "blur" {
				blurOverlays = append(blurOverlays, overlay)
			} else {
				coverOverlays = append(coverOverlays, overlay)
			}
		}

		previousLabel := "vbase"
		operationIndex := 0
		for _, overlay := range blurOverlays {
			nextLabel := fmt.Sprintf("voverlay%d", operationIndex)
			if operationIndex == len(overlays)+textCount-1 {
				nextLabel = "vout"
			}
			baseLabel := fmt.Sprintf("vblurbase%d", operationIndex)
			cropLabel := fmt.Sprintf("vblurcrop%d", operationIndex)
			blurredLabel := fmt.Sprintf("vblurred%d", operationIndex)

			filters = append(filters,
				fmt.Sprintf("[%s]split=2[%s][%s]", previousLabel, baseLabel, cropLabel),
				fmt.Sprintf(
					"[%s]crop=w=iw*%.6f:h=ih*%.6f:x=iw*%.6f:y=ih*%.6f,gblur=sigma=%d:steps=2[%s]",
					cropLabel,
					overlay.Width/100,
					overlay.Height/100,
					overlay.X/100,
					overlay.Y/100,
					editorBlurSigma,
					blurredLabel,
				),
				fmt.Sprintf(
					"[%s][%s]overlay=x=main_w*%.6f:y=main_h*%.6f:enable='between(t,%.3f,%.3f)'[%s]",
					baseLabel,
					blurredLabel,
					overlay.X/100,
					overlay.Y/100,
					overlay.Start,
					overlay.End,
					nextLabel,
				),
			)

			previousLabel = nextLabel
			operationIndex++
		}

		for _, overlay := range coverOverlays {
			nextLabel := fmt.Sprintf("voverlay%d", operationIndex)
			if operationIndex == len(overlays)+textCount-1 {
				nextLabel = "vout"
			}

			coverColor := "black"
			if overlay.Color != "" {
				coverColor = "0x" + overlay.Color[1:]
			}
			if overlay.Opacity != nil && *overlay.Opacity < 1 {
				coverLayer := fmt.Sprintf("vcover%d", operationIndex)
				filters = append(filters,
					fmt.Sprintf(
						"color=c=black@0.0:s=1920x1080:r=30:d=%.3f,format=rgba,drawbox=x=iw*%.6f:y=ih*%.6f:w=iw*%.6f:h=ih*%.6f:color=%s@%.3f:t=fill:replace=1[%s]",
						timelineDuration,
						overlay.X/100,
						overlay.Y/100,
						overlay.Width/100,
						overlay.Height/100,
						coverColor,
						*overlay.Opacity,
						coverLayer,
					),
					fmt.Sprintf(
						"[%s][%s]overlay=x=0:y=0:enable='between(t,%.3f,%.3f)'[%s]",
						previousLabel,
						coverLayer,
						overlay.Start,
						overlay.End,
						nextLabel,
					),
				)
				previousLabel = nextLabel
				operationIndex++
				continue
			}
			filters = append(filters, fmt.Sprintf(
				"[%s]drawbox=x=iw*%.6f:y=ih*%.6f:w=iw*%.6f:h=ih*%.6f:color=%s:t=fill:enable='between(t,%.3f,%.3f)'[%s]",
				previousLabel,
				overlay.X/100,
				overlay.Y/100,
				overlay.Width/100,
				overlay.Height/100,
				coverColor,
				overlay.Start,
				overlay.End,
				nextLabel,
			))

			previousLabel = nextLabel
			operationIndex++
		}

		// Draw all text after blur and cover fills, independently of fill alpha.
		for i, overlay := range overlays {
			x, y, width, height, visible := coverTextBounds(overlay)
			if !visible {
				continue
			}
			nextLabel := fmt.Sprintf("voverlay%d", operationIndex)
			if operationIndex == len(overlays)+textCount-1 {
				nextLabel = "vout"
			}
			textLayer := fmt.Sprintf("vtext%d", i)
			filters = append(filters,
				fmt.Sprintf("color=c=black@0.0:s=%dx%d:r=30:d=%.3f,format=rgba,drawtext=fontfile=%s:textfile=%s:expansion=none:fontcolor=white:fontsize=%d:x=(w-text_w)/2:y=(h-text_h)/2[%s]",
					width, height, timelineDuration, editorTextFont, coverTextFilename(i), editorTextFontSize, textLayer),
				fmt.Sprintf("[%s][%s]overlay=x=%d:y=%d:enable='between(t,%.3f,%.3f)'[%s]",
					previousLabel, textLayer, x, y, overlay.Start, overlay.End, nextLabel),
			)
			previousLabel = nextLabel
			operationIndex++
		}
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[vout]", "-map", "[aout]",
		"-c:v", "libx264", "-profile:v", "high", "-level:v", "5.1", "-preset", "fast", "-crf", "23",
		"-c:a", "aac", "-movflags", "+faststart", "-y", output)
	return args
}

func probeHasAudio(path string) bool {
	cmd := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", path)
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

func (h *Handler) renderTimelineAsync(ctx context.Context, job renderJob) {
	fail := func(err error) {
		msg := err.Error()
		if len(msg) > 1000 {
			msg = msg[:1000]
		}
		if _, dbErr := h.db.Exec(ctx, `UPDATE videos SET edit_render_status = 'failed', edit_render_error = $1,
			updated_at = now() WHERE id = $2`, msg, job.SourceVideoID); dbErr != nil {
			slog.Error("editor-render: failed to record error", "video_id", job.SourceVideoID, "error", dbErr)
		}
	}

	tmpDir, err := os.MkdirTemp("", "sendrec-editor-render-*")
	if err != nil {
		fail(err)
		return
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	inputs := make([]string, 0, len(job.Sources))
	indexes := make(map[string]int, len(job.Sources))
	for _, sourceID := range renderSourceIDs(job.Timeline) {
		source := job.Sources[sourceID]
		if _, exists := indexes[source.ID]; exists {
			continue
		}
		path := filepath.Join(tmpDir, fmt.Sprintf("source-%d%s", len(inputs), extensionForContentType(source.ContentType)))
		if err := h.storage.DownloadToFile(ctx, source.FileKey, path); err != nil {
			fail(err)
			return
		}
		source.HasAudio = probeHasAudio(path)
		job.Sources[source.ID] = source
		indexes[source.ID] = len(inputs)
		inputs = append(inputs, path)
	}

	output := filepath.Join(tmpDir, "rendered.mp4")
	if err := prepareCoverTextFiles(tmpDir, job.Timeline.Overlays); err != nil {
		fail(err)
		return
	}
	if err := prepareArrowFiles(tmpDir, job.Timeline); err != nil {
		fail(err)
		return
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", buildAnnotatedTimelineRenderArgs(inputs, job.Timeline.Clips, indexes, job.Sources, output, job.Timeline.Overlays, job.Timeline.Annotations, job.Timeline.AudioSegments)...)
	cmd.Dir = tmpDir
	if combined, err := cmd.CombinedOutput(); err != nil {
		fail(fmt.Errorf("ffmpeg render: %w: %s", err, string(combined)))
		return
	}
	info, err := os.Stat(output)
	if err != nil {
		fail(err)
		return
	}

	shareToken, err := generateShareToken()
	if err != nil {
		fail(err)
		return
	}
	resultKey := videoFileKey(job.OwnerID, shareToken, "video/mp4")
	if err := h.storage.UploadFile(ctx, resultKey, output, "video/mp4"); err != nil {
		fail(err)
		return
	}
	uploaded := true
	defer func() {
		if uploaded {
			_ = h.storage.DeleteObject(context.Background(), resultKey)
		}
	}()

	var resultID string
	totalDuration := 0.0
	for _, clip := range job.Timeline.Clips {
		totalDuration += clipTimelineDuration(clip)
	}
	err = h.db.QueryRow(ctx, `INSERT INTO videos
		(user_id, organization_id, title, status, duration, file_size, file_key, share_token, content_type, ios_normalized)
		VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, 'video/mp4', true) RETURNING id`,
		job.OwnerID, job.OrganizationID, job.Title, int(totalDuration), info.Size(), resultKey, shareToken).Scan(&resultID)
	if err != nil {
		fail(err)
		return
	}
	uploaded = false

	if _, err := h.db.Exec(ctx, `UPDATE videos SET edit_render_status = 'ready', edit_render_error = NULL,
		edit_render_video_id = $1, updated_at = now() WHERE id = $2`, resultID, job.SourceVideoID); err != nil {
		fail(err)
		return
	}
	GenerateThumbnail(ctx, h.db, h.storage, resultID, resultKey, thumbnailFileKey(job.OwnerID, shareToken))
	if err := EnqueueTranscription(ctx, h.db, resultID); err != nil {
		slog.Error("editor-render: failed to enqueue transcription", "video_id", resultID, "error", err)
	}
}
