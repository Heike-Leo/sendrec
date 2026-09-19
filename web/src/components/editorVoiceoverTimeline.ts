import { audioSegmentTimelineDuration, cloneAudioSegment, validateAudioSegments, type EditorAudioSegment } from "./editorAudioGeometry";
import { layoutEditorClips, type EditorClip } from "./editorClipTime";
import type { EditorVoiceoverSession } from "./editorVoiceoverSession";
import { stopAndUploadVoiceover, type UploadedVoiceover } from "./editorVoiceoverUpload";

/** The uploaded take is a normal, independent audio-asset segment. */
export function voiceoverSegment(asset: UploadedVoiceover, clips: EditorClip[], existing: EditorAudioSegment[],
  id = crypto.randomUUID()): EditorAudioSegment {
  const segment: EditorAudioSegment = {
    id, trackId: "voiceover-1", source: { kind: "audioAsset", assetId: asset.assetId },
    sourceStart: 0, sourceEnd: asset.duration, timelineStart: asset.timelineStart,
    geometryLinked: false, speed: 1, muted: false, volume: 1,
  };
  const timelineEnd = layoutEditorClips(clips).at(-1)?.timelineEnd ?? 0;
  if (!Number.isFinite(asset.duration) || asset.duration <= 0 || !Number.isFinite(asset.timelineStart) ||
    asset.timelineStart < 0 || asset.timelineStart + audioSegmentTimelineDuration(segment, clips) > timelineEnd + 0.001) {
    throw new Error("Voice-over liegt außerhalb der Videotimeline.");
  }
  validateAudioSegments([...existing, segment], clips);
  return segment;
}

/** Supply the editor's existing rememberEditorState and setAudioSegments actions.
 * Neither is called if recording, upload or segment validation fails.
 */
export async function finishVoiceoverToTimeline(
  session: Pick<EditorVoiceoverSession, "stop">,
  clips: EditorClip[], existing: EditorAudioSegment[],
  editor: { rememberEditorState: () => void; setAudioSegments: (next: EditorAudioSegment[]) => void },
): Promise<EditorAudioSegment | null> {
  const asset = await stopAndUploadVoiceover(session);
  if (!asset) return null;
  const segment = voiceoverSegment(asset, clips, existing);
  editor.rememberEditorState();
  editor.setAudioSegments([...existing.map(cloneAudioSegment), segment]);
  return segment;
}
