package video

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/sendrec/sendrec/internal/auth"
	"github.com/sendrec/sendrec/internal/httputil"
)

const audioAssetMaxBytes int64 = 50 * 1024 * 1024
const audioAssetMaxDuration = 1800.0

type audioAsset struct {
	ID               string    `json:"id"`
	StorageKey       string    `json:"-"`
	OriginalFilename string    `json:"originalFilename"`
	MIMEType         string    `json:"mimeType"`
	FileSize         int64     `json:"fileSize"`
	Duration         float64   `json:"duration"`
	CreatedAt        time.Time `json:"createdAt"`
}

func audioAssetMIME(value string) (string, error) {
	kind, _, err := mime.ParseMediaType(value)
	if err != nil {
		return "", fmt.Errorf("invalid audio MIME type")
	}
	switch kind {
	case "audio/webm":
		return "audio/webm", nil
	case "audio/mp4", "audio/x-m4a":
		return "audio/mp4", nil
	}
	return "", fmt.Errorf("only audio/webm (Opus) and audio/mp4 (AAC) are supported")
}

// Verify the real container and every stream; MIME is not evidence of audio.
func validateAudioAssetProbe(raw []byte, declared string) error {
	var probe struct {
		Format struct {
			Name string `json:"format_name"`
		} `json:"format"`
		Streams []struct {
			Type  string `json:"codec_type"`
			Codec string `json:"codec_name"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return fmt.Errorf("invalid media probe")
	}
	if len(probe.Streams) != 1 || probe.Streams[0].Type != "audio" {
		return fmt.Errorf("source must contain exactly one audio stream and no video")
	}
	container, codec := probe.Format.Name, probe.Streams[0].Codec
	if declared == "audio/webm" && strings.Contains(container, "webm") && codec == "opus" {
		return nil
	}
	if declared == "audio/mp4" && strings.Contains(container, "mp4") && codec == "aac" {
		return nil
	}
	return fmt.Errorf("actual container/codec does not match supported audio MIME type")
}

// Prefer playback metadata, which accounts for AAC encoder padding/edit lists.
// Always decode for integrity. For streaming WebM without duration metadata,
// count decoded PCM samples, never the timestamp of the last progress event.
func inspectAudioAsset(ctx context.Context, path, declared string) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,duration,duration_ts,time_base", "-of", "json", path).Output()
	if err != nil {
		return 0, fmt.Errorf("audio format could not be inspected: %w", err)
	}
	if err := validateAudioAssetProbe(probe, declared); err != nil {
		return 0, err
	}
	duration, err := audioAssetMetadataDuration(probe)
	if err != nil {
		return 0, err
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov", "-i", path, "-map", "0:a:0", "-af", "asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0", "-t", "1801", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1")
	pcm, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("audio could not be decoded: %w", err)
	}
	// Stream into a sink: no decoded audio is retained in memory or on disk.
	bytes, readErr := io.Copy(io.Discard, pcm)
	err = cmd.Wait()
	if readErr != nil {
		return 0, fmt.Errorf("audio decode read failed: %w", readErr)
	}
	if err != nil {
		return 0, fmt.Errorf("audio could not be decoded: %w", err)
	}
	decoded := float64(bytes) / (48000 * 2)
	if bytes <= 0 || bytes%2 != 0 || decoded >= 1801 {
		return 0, fmt.Errorf("invalid or excessive decoded audio duration")
	}
	if duration == 0 {
		duration = decoded
	}
	return validateAudioAssetDuration(duration)
}

func audioAssetMetadataDuration(raw []byte) (float64, error) {
	var probe struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Duration string          `json:"duration"`
			Ticks    json.RawMessage `json:"duration_ts"`
			TimeBase string          `json:"time_base"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return 0, fmt.Errorf("invalid duration metadata: %w", err)
	}
	positive := func(value string) float64 {
		v, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
			return 0
		}
		return v
	}
	if duration := positive(probe.Format.Duration); duration > 0 {
		return validateAudioAssetDuration(duration)
	}
	if len(probe.Streams) == 1 {
		stream := probe.Streams[0]
		if duration := positive(stream.Duration); duration > 0 {
			return validateAudioAssetDuration(duration)
		}
		numerator, denominator, ok := strings.Cut(stream.TimeBase, "/")
		if ok && positive(denominator) > 0 {
			duration := positive(strings.Trim(string(stream.Ticks), "\"")) * positive(numerator) / positive(denominator)
			if duration > 0 {
				return validateAudioAssetDuration(duration)
			}
		}
	}
	return 0, nil // No usable metadata: caller must fully decode and count samples.
}

func validateAudioAssetDuration(duration float64) (float64, error) {
	if math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > audioAssetMaxDuration {
		return 0, fmt.Errorf("audio duration must be between 0 and 1800 seconds")
	}
	return duration, nil
}

// Upload is intentionally server-mediated: only verified bytes reach a fresh,
// server-generated immutable key. No reusable PUT URL can replace ready bytes.
func (h *Handler) UploadAudioAsset(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		httputil.WriteError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	limit := audioAssetMaxBytes
	if h.maxUploadBytes > 0 && h.maxUploadBytes < limit {
		limit = h.maxUploadBytes
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+64*1024)
	reader, err := r.MultipartReader()
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "multipart audio file required")
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "file" {
		httputil.WriteError(w, http.StatusBadRequest, "one file part required")
		return
	}
	defer part.Close()
	contentType, err := audioAssetMIME(part.Header.Get("Content-Type"))
	if err != nil {
		httputil.WriteError(w, http.StatusUnsupportedMediaType, err.Error())
		return
	}
	file, err := os.CreateTemp("", "sendrec-audio-asset-*")
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "cannot prepare audio upload")
		return
	}
	path := file.Name()
	defer os.Remove(path)
	size, copyErr := io.Copy(file, io.LimitReader(part, limit+1))
	closeErr := file.Close()
	if size > limit {
		httputil.WriteError(w, http.StatusRequestEntityTooLarge, "audio file too large")
		return
	}
	if copyErr != nil || closeErr != nil || size == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "invalid audio upload")
		return
	}
	if _, err = reader.NextPart(); err != io.EOF {
		httputil.WriteError(w, http.StatusBadRequest, "only one audio file is allowed")
		return
	}
	duration, err := inspectAudioAsset(r.Context(), path, contentType)
	if err != nil {
		httputil.WriteError(w, http.StatusUnprocessableEntity, "audio validation failed")
		return
	}
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "cannot allocate audio asset")
		return
	}
	randomID[6] = (randomID[6] & 0x0f) | 0x40
	randomID[8] = (randomID[8] & 0x3f) | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", randomID[0:4], randomID[4:6], randomID[6:8], randomID[8:10], randomID[10:16])
	filename := part.FileName()
	if filename != "" {
		filename = filepath.Base(strings.ReplaceAll(filename, "\\", "/"))
	}
	asset := audioAsset{ID: id, OriginalFilename: filename, MIMEType: contentType, FileSize: size, Duration: duration}
	if len(asset.OriginalFilename) > 255 {
		httputil.WriteError(w, http.StatusBadRequest, "filename too long")
		return
	}
	asset.StorageKey = "audio-assets/" + asset.ID
	if err := h.storage.UploadFile(r.Context(), asset.StorageKey, path, contentType); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "audio storage failed")
		return
	}
	err = h.db.QueryRow(r.Context(), `INSERT INTO audio_assets (id, user_id, organization_id, storage_key, original_filename, mime_type, file_size, duration)
		VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8) RETURNING created_at`, asset.ID, userID, auth.OrgIDFromContext(r.Context()), asset.StorageKey, asset.OriginalFilename, contentType, size, duration).Scan(&asset.CreatedAt)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if cleanupErr := h.storage.DeleteObject(cleanup, asset.StorageKey); cleanupErr != nil {
			slog.Error("audio asset orphan cleanup failed", "storage_key", asset.StorageKey, "error", cleanupErr)
		}
		httputil.WriteError(w, http.StatusInternalServerError, "cannot save audio asset")
		return
	}
	httputil.WriteJSON(w, http.StatusCreated, asset)
}

// Scope is owner AND current workspace, including the personal (NULL) workspace.
// Organization membership is established by the existing route middleware.
func (h *Handler) resolveAudioAsset(ctx context.Context, id string) (audioAsset, error) {
	var asset audioAsset
	var parsed pgtype.UUID
	if err := parsed.Scan(id); err != nil || !parsed.Valid || auth.UserIDFromContext(ctx) == "" {
		return asset, fmt.Errorf("audio asset unavailable")
	}
	err := h.db.QueryRow(ctx, `SELECT id, storage_key, original_filename, mime_type, file_size, duration, created_at FROM audio_assets
		WHERE id = $1 AND user_id = $2 AND organization_id IS NOT DISTINCT FROM NULLIF($3, '')::uuid`, id, auth.UserIDFromContext(ctx), auth.OrgIDFromContext(ctx)).Scan(&asset.ID, &asset.StorageKey, &asset.OriginalFilename, &asset.MIMEType, &asset.FileSize, &asset.Duration, &asset.CreatedAt)
	return asset, err
}

func (h *Handler) GetAudioAsset(w http.ResponseWriter, r *http.Request) {
	asset, err := h.resolveAudioAsset(r.Context(), chi.URLParam(r, "assetId"))
	if err != nil {
		httputil.WriteError(w, http.StatusNotFound, "audio asset not found")
		return
	}
	url, err := h.storage.GenerateDownloadURL(r.Context(), asset.StorageKey, 5*time.Minute)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "cannot access audio asset")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httputil.WriteJSON(w, http.StatusOK, struct {
		audioAsset
		URL string `json:"url"`
	}{asset, url})
}

func (h *Handler) validateTimelineAudioAssets(ctx context.Context, timeline editTimeline) error {
	if timeline.AudioSegments == nil {
		return nil
	}
	resolved := map[string]audioAsset{}
	for _, segment := range *timeline.AudioSegments {
		if segment.Source == nil || segment.Source.Kind != "audioAsset" {
			continue
		}
		id := segment.Source.AssetID
		asset, ok := resolved[id]
		if !ok {
			var err error
			asset, err = h.resolveAudioAsset(ctx, id)
			if err != nil {
				return fmt.Errorf("audio asset unavailable")
			}
			resolved[id] = asset
		}
		if segment.SourceEnd > asset.Duration+editorAudioTolerance {
			return fmt.Errorf("audio segment exceeds audio asset duration")
		}
	}
	return nil
}
