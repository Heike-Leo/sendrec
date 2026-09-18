CREATE TABLE audio_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL CHECK (mime_type IN ('audio/webm', 'audio/mp4')),
    file_size BIGINT NOT NULL CHECK (file_size > 0 AND file_size <= 52428800),
    duration DOUBLE PRECISION NOT NULL CHECK (duration > 0 AND duration <= 1800),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assets are inserted only after successful validation/upload. No pending rows.
-- Future cleanup must check persisted audioAsset references before deletion;
-- created_at is a grace-period candidate, not an automatic expiration date.
CREATE INDEX audio_assets_owner ON audio_assets(user_id, organization_id);
CREATE INDEX audio_assets_created_at ON audio_assets(created_at);
