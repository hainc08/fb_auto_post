import { countSpokenWords, type ReelWord } from './subtitles';

/**
 * The scenes of a Reel: pure data work, no I/O (tested from tests/reel-scenes.test.ts).
 * A scene is a piece of the spoken script with its own picture; the picture changes when the voice reaches the scene.
 */

export interface ReelScene {
  /** 8 hex characters; also part of the scene's picture file name */
  id: string;
  /** What the voice reads */
  text: string;
  /** English description the picture is generated from */
  imagePrompt: string;
  /** File name in STORAGE_DIR/reels (scene-store.ts), or null: the post's picture is used */
  image: string | null;
}

/** Stored in Post.reelDraft */
export interface ReelDraft {
  voice: string;
  scenes: ReelScene[];
}

export const MAX_SCENES = 8;
/** One request to the voice service; about 90 seconds of Vietnamese speech */
export const MAX_SCRIPT_CHARS = 1500;
export const MIN_WORDS = 5;
export const DEFAULT_VOICE = 'vi-VN-HoaiMyNeural';
/** Id of the single scene a pre-scenes Reel is read as */
const LEGACY_SCENE_ID = '00000000';

/** What the voice reads: the scenes one after another */
export const draftScript = (scenes: Array<{ text: string }>) =>
  scenes
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');

/** Why these scenes cannot be rendered (shown to the user); null = fine */
export function draftProblem(scenes: Array<{ text: string }>): string | null {
  if (!scenes.length) return 'Kịch bản chưa có cảnh nào.';
  if (scenes.length > MAX_SCENES) return `Tối đa ${MAX_SCENES} cảnh.`;
  const script = draftScript(scenes);
  if (script.length > MAX_SCRIPT_CHARS) return `Kịch bản tối đa ${MAX_SCRIPT_CHARS} ký tự (đang ${script.length}).`;
  const silent = scenes.findIndex((s) => countSpokenWords(s.text) === 0);
  if (silent !== -1 && scenes.length > 1) return `Cảnh ${silent + 1} chưa có lời đọc.`;
  if (countSpokenWords(script) < MIN_WORDS) return `Kịch bản cần ít nhất ${MIN_WORDS} từ.`;
  return null;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Post.reelDraft as stored, tolerant of anything malformed. A post whose Reel was made before
 * scenes existed has no draft: its script (inputData.reelScript) becomes one scene.
 */
export function parseDraft(raw: unknown, legacyScript?: string | null, legacyVoice?: string | null): ReelDraft {
  const stored = raw && typeof raw === 'object' ? (raw as { voice?: unknown; scenes?: unknown }) : null;
  if (stored && Array.isArray(stored.scenes)) {
    const scenes = stored.scenes
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
      .map((s) => ({ id: s.id as string, text: text(s.text), imagePrompt: text(s.imagePrompt), image: typeof s.image === 'string' ? s.image : null }));
    return { voice: text(stored.voice) || DEFAULT_VOICE, scenes };
  }
  const script = (legacyScript ?? '').trim();
  return {
    voice: legacyVoice || DEFAULT_VOICE,
    scenes: script ? [{ id: LEGACY_SCENE_ID, text: script, imagePrompt: '', image: null }] : [],
  };
}

/**
 * The scenes as edited in the dialog, applied to the stored ones: a scene that kept its id keeps its
 * picture (and its image prompt when none is sent); anything else is a new scene.
 * `dropped`: picture files of scenes that are gone.
 */
export function mergeScenes(
  current: ReelScene[],
  incoming: Array<{ id?: string; text: string; imagePrompt?: string }>,
  newId: () => string
): { scenes: ReelScene[]; dropped: string[] } {
  const left = new Map(current.map((s) => [s.id, s]));
  const scenes = incoming.map((s) => {
    const old = s.id ? left.get(s.id) : undefined;
    if (old) left.delete(old.id);
    return { id: old?.id ?? newId(), text: s.text, imagePrompt: s.imagePrompt ?? old?.imagePrompt ?? '', image: old?.image ?? null };
  });
  return { scenes, dropped: [...left.values()].flatMap((s) => (s.image ? [s.image] : [])) };
}

/**
 * When each scene starts, in ms from the start of the voice. The voice reads all scenes in one go and
 * reports a mark per spoken word: a scene starts at its first word. When the voice counted the words
 * differently (it splits numbers, reads symbols), the time is shared by text length instead.
 */
export function sceneStarts(texts: string[], words: ReelWord[]): number[] {
  if (!texts.length) return [];
  const last = words[words.length - 1];
  const end = last ? last.startMs + last.durationMs : 0;
  const counts = texts.map(countSpokenWords);
  const starts = [0];
  if (counts.reduce((a, b) => a + b, 0) === words.length) {
    let offset = 0;
    for (let i = 1; i < texts.length; i++) {
      offset += counts[i - 1];
      starts.push(words[offset]?.startMs ?? end);
    }
    return starts;
  }
  const lengths = texts.map((t) => t.length || 1);
  const total = lengths.reduce((a, b) => a + b, 0);
  let before = 0;
  for (let i = 1; i < texts.length; i++) {
    before += lengths[i - 1];
    starts.push(Math.round((end * before) / total));
  }
  return starts;
}
