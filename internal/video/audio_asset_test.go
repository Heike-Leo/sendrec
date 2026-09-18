package video

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/pashagolub/pgxmock/v4"
	"github.com/sendrec/sendrec/internal/auth"
)

const testAudioAssetID = "550e8400-e29b-41d4-a716-446655440001"

func testAudioAssetRows(duration float64) *pgxmock.Rows {
	return pgxmock.NewRows([]string{"id", "storage_key", "original_filename", "mime_type", "file_size", "duration", "created_at"}).AddRow(testAudioAssetID, "audio-assets/"+testAudioAssetID, "voice.m4a", "audio/mp4", int64(123), duration, time.Unix(123, 0))
}

func TestAudioAssetFormatValidation(t *testing.T) {
	for _, tc := range []struct {
		name, container, codec, kind, mime string
		valid                              bool
	}{
		{"webm", "matroska,webm", "opus", "audio", "audio/webm", true},
		{"m4a", "mov,mp4,m4a,3gp,3g2,mj2", "aac", "audio", "audio/mp4", true},
		{"spoofed MIME", "mov,mp4", "aac", "audio", "audio/webm", false},
		{"no audio", "mov,mp4", "h264", "video", "audio/mp4", false},
		{"unsupported codec", "matroska,webm", "vorbis", "audio", "audio/webm", false},
		{"playlist", "hls", "aac", "audio", "audio/mp4", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := fmt.Sprintf(`{"format":{"format_name":%q},"streams":[{"codec_type":%q,"codec_name":%q}]}`, tc.container, tc.kind, tc.codec)
			if err := validateAudioAssetProbe([]byte(raw), tc.mime); (err == nil) != tc.valid {
				t.Fatalf("valid=%v: %v", tc.valid, err)
			}
		})
	}
	for _, raw := range []string{"not audio", `{}`, `{"streams":[{"codec_type":"audio","codec_name":"aac"},{"codec_type":"video"}]}`} {
		if validateAudioAssetProbe([]byte(raw), "audio/mp4") == nil {
			t.Fatal("invalid file accepted")
		}
	}
	for _, value := range []string{"audio/webm;codecs=opus", "audio/mp4", "audio/x-m4a"} {
		if _, err := audioAssetMIME(value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"video/mp4", "text/plain", "audio/wav", ""} {
		if _, err := audioAssetMIME(value); err == nil {
			t.Fatal("unsupported MIME accepted")
		}
	}
}

func TestAudioAssetDuration(t *testing.T) {
	for _, tc := range []struct {
		input    string
		expected float64
	}{
		{`{"format":{"duration":"0.400"},"streams":[{"duration":"0.405333"}]}`, 0.4},
		{`{"streams":[{"duration":"0.4"}]}`, 0.4},
		{`{"streams":[{"duration_ts":19200,"time_base":"1/48000"}]}`, 0.4},
		{`{"format":{"duration":"NaN"},"streams":[{"duration":"0.01"}]}`, 0.01},
		{`{"format":{"duration":"1799.999"}}`, 1799.999},
		{`{"format":{"duration":"1800"}}`, 1800},
		{`{}`, 0},
		{`{"format":{"duration":"N/A"},"streams":[{"duration":"Infinity","time_base":"1/0"}]}`, 0},
		{`{"format":{"duration":"-1"}}`, 0},
		{`{"streams":[{"duration_ts":"N/A","time_base":"1/48000"}]}`, 0},
	} {
		got, err := audioAssetMetadataDuration([]byte(tc.input))
		if err != nil || got != tc.expected {
			t.Fatal(got, err)
		}
	}
	for _, input := range []string{"", `{"format":{"duration":"1800.001"}}`, `{"streams":[{"duration":"1801"}]}`} {
		if _, err := audioAssetMetadataDuration([]byte(input)); err == nil {
			t.Fatal("invalid duration accepted", input)
		}
	}
	for _, value := range []float64{0, -1, 1800.001} {
		if _, err := validateAudioAssetDuration(value); err == nil {
			t.Fatal("invalid duration", value)
		}
	}
}

func TestAudioAssetAccessAndReferences(t *testing.T) {
	for _, tc := range []struct {
		name, user, org string
		found           bool
	}{
		{"owner", testUserID, "", true},
		{"workspace owner", testUserID, "550e8400-e29b-41d4-a716-446655440002", true},
		{"foreign user", "550e8400-e29b-41d4-a716-446655440003", "", false},
		{"foreign workspace", testUserID, "550e8400-e29b-41d4-a716-446655440004", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mock, err := pgxmock.NewPool()
			if err != nil {
				t.Fatal(err)
			}
			defer mock.Close()
			h := NewHandler(mock, &mockStorage{downloadURL: "signed"}, "", 0, 0, 0, 0, "", false)
			ctx := auth.ContextWithOrg(auth.ContextWithUserID(context.Background(), tc.user), tc.org, "member")
			query := mock.ExpectQuery(`SELECT id, storage_key.*WHERE id = \$1 AND user_id = \$2 AND organization_id IS NOT DISTINCT FROM NULLIF\(\$3, ''\)::uuid`).WithArgs(testAudioAssetID, tc.user, tc.org)
			if tc.found {
				query.WillReturnRows(testAudioAssetRows(3))
			} else {
				query.WillReturnError(pgx.ErrNoRows)
			}
			router := chi.NewRouter()
			router.Get("/{assetId}", h.GetAudioAsset)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest("GET", "/"+testAudioAssetID, nil).WithContext(ctx))
			expected := 404
			if tc.found {
				expected = 200
			}
			if w.Code != expected {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.found && (!strings.Contains(w.Body.String(), `"url":"signed"`) || strings.Contains(w.Body.String(), "storage_key") || w.Header().Get("Cache-Control") != "no-store") {
				t.Fatal(w.Body.String())
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, tc := range []struct {
		name         string
		end          float64
		found, valid bool
	}{{"valid", 2, true, true}, {"past source", 4, true, false}, {"foreign", 2, false, false}} {
		t.Run(tc.name, func(t *testing.T) {
			mock, _ := pgxmock.NewPool()
			defer mock.Close()
			h := NewHandler(mock, nil, "", 0, 0, 0, 0, "", false)
			query := mock.ExpectQuery(`SELECT id, storage_key`).WithArgs(testAudioAssetID, testUserID, "")
			if tc.found {
				query.WillReturnRows(testAudioAssetRows(3))
			} else {
				query.WillReturnError(pgx.ErrNoRows)
			}
			segments := []editorAudioSegment{{Source: &editorAudioSource{Kind: "audioAsset", AssetID: testAudioAssetID}, SourceEnd: tc.end}}
			ctx := auth.ContextWithUserID(context.Background(), testUserID)
			if err := h.validateTimelineAudioAssets(ctx, editTimeline{AudioSegments: &segments}); (err == nil) != tc.valid {
				t.Fatal(err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
	h := &Handler{}
	legacy := []editorAudioSegment{{SourceVideoID: "v", SourceClipID: "c", SourceEnd: 2}, {Source: &editorAudioSource{Kind: "video", VideoID: "v", ClipID: "c"}, SourceEnd: 2}}
	if err := h.validateTimelineAudioAssets(context.Background(), editTimeline{AudioSegments: &legacy}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.resolveAudioAsset(context.Background(), testAudioAssetID); err == nil {
		t.Fatal("anonymous access accepted")
	}
}

func audioAssetUploadRequest(t *testing.T, data []byte, kind string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="file"; filename="voice.webm"`)
	header.Set("Content-Type", kind)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/", &buf)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	return r.WithContext(auth.ContextWithUserID(r.Context(), testUserID))
}

func TestAudioAssetUploadLimits(t *testing.T) {
	h := &Handler{maxUploadBytes: 10}
	for _, tc := range []struct {
		data, kind string
		status     int
	}{{"12345678901", "audio/webm", 413}, {"", "audio/webm", 400}, {"hello", "image/png", 415}} {
		w := httptest.NewRecorder()
		h.UploadAudioAsset(w, audioAssetUploadRequest(t, []byte(tc.data), tc.kind))
		if w.Code != tc.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	h.UploadAudioAsset(w, httptest.NewRequest("POST", "/", nil))
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestAudioAssetForeignReferenceCannotBeSaved(t *testing.T) {
	mock, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer mock.Close()
	h := NewHandler(mock, &mockStorage{}, "", 0, 0, 0, 0, "", false)
	mock.ExpectQuery(`SELECT id, storage_key`).WithArgs(testAudioAssetID, testUserID, "").WillReturnError(pgx.ErrNoRows)
	body := `{"version":1,"clips":[{"id":"c","sourceId":"v","sourceStart":0,"sourceEnd":5}],"audioSegments":[{"id":"a","source":{"kind":"audioAsset","assetId":"` + testAudioAssetID + `"},"sourceStart":0,"sourceEnd":1,"timelineStart":0}]}`
	router := chi.NewRouter()
	router.With(newAuthMiddleware()).Put("/{id}", h.SaveEditorTimeline)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, authenticatedRequest(t, "PUT", "/video", []byte(body)))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "audio asset unavailable") {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAudioAssetFFmpeg(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	for _, tc := range []struct{ name, codec, mime string }{{"voice.webm", "libopus", "audio/webm"}, {"voice.m4a", "aac", "audio/mp4"}} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.name)
			if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.4", "-c:a", tc.codec, path).CombinedOutput(); err != nil {
				t.Fatal(err, string(out))
			}
			duration, err := inspectAudioAsset(context.Background(), path, tc.mime)
			if err != nil || duration < 0.39 || duration > 0.45 {
				t.Fatal(duration, err)
			}
			wrong := "audio/mp4"
			if tc.mime == wrong {
				wrong = "audio/webm"
			}
			if _, err := inspectAudioAsset(context.Background(), path, wrong); err == nil {
				t.Fatal("spoofed MIME accepted")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			mock, _ := pgxmock.NewPool()
			defer mock.Close()
			mock.ExpectQuery(`INSERT INTO audio_assets`).WithArgs(pgxmock.AnyArg(), testUserID, "", pgxmock.AnyArg(), "voice.webm", tc.mime, int64(len(data)), pgxmock.AnyArg()).WillReturnRows(pgxmock.NewRows([]string{"created_at"}).AddRow(time.Now()))
			storage := &mockStorage{}
			h := NewHandler(mock, storage, "", 0, 0, 0, 0, "", false)
			w := httptest.NewRecorder()
			h.UploadAudioAsset(w, audioAssetUploadRequest(t, data, tc.mime))
			if w.Code != 201 {
				t.Fatal(w.Code, w.Body.String())
			}
			var asset audioAsset
			if err := json.Unmarshal(w.Body.Bytes(), &asset); err != nil {
				t.Fatal(err)
			}
			if storage.uploadFileCallCount != 1 || storage.uploadFileKeys[0] != "audio-assets/"+asset.ID || asset.Duration <= 0 {
				t.Fatal("invalid stored asset", asset)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("streaming WebM without duration metadata", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "live.webm")
		if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "0.4", "-c:a", "libopus", "-live", "1", path).CombinedOutput(); err != nil {
			t.Fatal(err, string(out))
		}
		probe, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=duration,duration_ts,time_base", "-of", "json", path).Output()
		if err != nil {
			t.Fatal(err)
		}
		if value, err := audioAssetMetadataDuration(probe); err != nil || value != 0 {
			t.Fatal("fixture must exercise fallback", value, err)
		}
		value, err := inspectAudioAsset(context.Background(), path, "audio/webm")
		if err != nil || value < 0.399 || value > 0.401 {
			t.Fatal(value, err)
		}
	})
	t.Run("very short AAC", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "short.m4a")
		if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "0.01", "-c:a", "aac", path).CombinedOutput(); err != nil {
			t.Fatal(err, string(out))
		}
		value, err := inspectAudioAsset(context.Background(), path, "audio/mp4")
		if err != nil || value < 0.009 || value > 0.011 {
			t.Fatal(value, err)
		}
	})
	path := filepath.Join(t.TempDir(), "video.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.2", "-an", path).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	if _, err := inspectAudioAsset(context.Background(), path, "audio/mp4"); err == nil {
		t.Fatal("video-only source accepted")
	}
	textPath := filepath.Join(t.TempDir(), "fake.m4a")
	if err := os.WriteFile(textPath, []byte("this is not audio"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectAudioAsset(context.Background(), textPath, "audio/mp4"); err == nil {
		t.Fatal("non-audio file accepted")
	}
}

func TestAudioAssetMetadataDoesNotBypassDecode(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ffprobe"), []byte("#!/bin/sh\nprintf '%s' '{\"format\":{\"format_name\":\"mov,mp4\",\"duration\":\"0.4\"},\"streams\":[{\"codec_type\":\"audio\",\"codec_name\":\"aac\"}]}'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "ffmpeg"), []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if _, err := inspectAudioAsset(context.Background(), "fixture", "audio/mp4"); err == nil || !strings.Contains(err.Error(), "could not be decoded") {
		t.Fatal("metadata bypassed integrity check", err)
	}
}

func TestAudioAssetDurationLimitFFmpeg(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip(tool + " unavailable")
		}
	}
	for _, format := range []struct{ name, codec, mime string }{{"webm", "libopus", "audio/webm"}, {"m4a", "aac", "audio/mp4"}} {
		for _, seconds := range []string{"1799.9", "1800.1"} {
			t.Run(format.name+"/"+seconds, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "limit."+format.name)
				if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", seconds, "-c:a", format.codec, path).CombinedOutput(); err != nil {
					t.Fatal(err, string(out))
				}
				duration, err := inspectAudioAsset(context.Background(), path, format.mime)
				if seconds == "1800.1" {
					if err == nil {
						t.Fatal("30-minute limit bypassed", duration)
					}
				} else if err != nil || duration < 1799.89 || duration > 1799.92 {
					t.Fatal(duration, err)
				}
			})
		}
	}
}
