package video

import (
	"context"
	"fmt"
)

func renderInputKeys(timeline editTimeline) []string {
	keys := renderSourceIDs(timeline)
	seen := map[string]bool{}
	for _, key := range keys {
		seen[key] = true
	}
	if timeline.AudioSegments != nil {
		for _, s := range *timeline.AudioSegments {
			key := audioRenderSourceKey(s)
			if !seen[key] {
				keys = append(keys, key)
				seen[key] = true
			}
		}
	}
	return keys
}

// Reauthorize every distinct asset for this request, never accept client storage
// keys or signed URLs. Keep precise asset duration separate from legacy videos.
func (h *Handler) resolveRenderAudioAssets(ctx context.Context, timeline editTimeline, sources map[string]sourceVideo) error {
	if timeline.AudioSegments == nil {
		return nil
	}
	for _, s := range *timeline.AudioSegments {
		if s.Source == nil || s.Source.Kind != "audioAsset" {
			continue
		}
		key := audioRenderSourceKey(s)
		if _, ok := sources[key]; ok {
			continue
		}
		asset, err := h.resolveAudioAsset(ctx, s.Source.AssetID)
		if err != nil {
			return fmt.Errorf("audio asset unavailable")
		}
		if _, err := audioAssetMIME(asset.MIMEType); err != nil {
			return err
		}
		if _, err := validateAudioAssetDuration(asset.Duration); err != nil {
			return err
		}
		if asset.StorageKey == "" || asset.FileSize <= 0 || asset.FileSize > audioAssetMaxBytes {
			return fmt.Errorf("invalid audio asset metadata")
		}
		sources[key] = sourceVideo{ID: key, FileKey: asset.StorageKey, ContentType: asset.MIMEType, AudioAsset: &asset, HasAudio: true}
	}
	return nil
}

func renderSourceExtension(source sourceVideo) string {
	if source.AudioAsset != nil {
		if source.ContentType == "audio/webm" {
			return ".webm"
		}
		return ".m4a"
	}
	return extensionForContentType(source.ContentType)
}

// Missing/corrupt assets fail the entire job, including muted assets. No silent
// fallback to anullsrc. Existing video download/probe behavior is unchanged.
func (h *Handler) downloadRenderSource(ctx context.Context, source sourceVideo, path string) error {
	if err := h.storage.DownloadToFile(ctx, source.FileKey, path); err != nil {
		if source.AudioAsset == nil {
			return err // Preserve the legacy video-source error verbatim.
		}
		return fmt.Errorf("render source download: %w", err)
	}
	if source.AudioAsset != nil {
		duration, err := inspectAudioAsset(ctx, path, source.ContentType)
		if err != nil {
			return fmt.Errorf("render audio asset: %w", err)
		}
		if duration+editorAudioTolerance < source.AudioAsset.Duration {
			return fmt.Errorf("render audio asset is shorter than its stored duration")
		}
	}
	return nil
}
