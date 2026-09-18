package migrations

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestAudioAssetMigrationEmbedded(t *testing.T) {
	up, err := FS.ReadFile("000061_create_audio_assets.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"CREATE TABLE audio_assets", "REFERENCES users(id)", "organization_id", "storage_key", "original_filename", "mime_type", "file_size", "duration", "created_at", "52428800", "1800"} {
		if !strings.Contains(string(up), required) {
			t.Fatal("missing", required)
		}
	}
	if strings.Contains(string(up), "ALTER TABLE") {
		t.Fatal("existing tables changed")
	}
	if _, err := FS.ReadFile("000061_create_audio_assets.down.sql"); err != nil {
		t.Fatal(err)
	}
}

// Opt-in disposable test database only; never uses the application's DATABASE_URL.
func TestAudioAssetMigrationPostgres(t *testing.T) {
	url := os.Getenv("AUDIO_ASSET_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AUDIO_ASSET_TEST_DATABASE_URL not configured")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `CREATE SCHEMA audio_asset_migration_test; SET LOCAL search_path TO audio_asset_migration_test; CREATE TABLE users(id UUID PRIMARY KEY); CREATE TABLE organizations(id UUID PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	up, _ := FS.ReadFile("000061_create_audio_assets.up.sql")
	if _, err := tx.Exec(ctx, string(up)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users VALUES ('550e8400-e29b-41d4-a716-446655440000'); INSERT INTO audio_assets(user_id,storage_key,mime_type,file_size,duration) VALUES ('550e8400-e29b-41d4-a716-446655440000','audio-assets/test','audio/webm',10,1.25)`); err != nil {
		t.Fatal(err)
	}
	down, _ := FS.ReadFile("000061_create_audio_assets.down.sql")
	if _, err := tx.Exec(ctx, string(down)); err != nil {
		t.Fatal(err)
	}
}
