import { writeFile } from 'node:fs/promises';
import { edgeTts } from '../src/lib/reel/edge-tts';

/** Manual check of the unofficial Edge TTS endpoint: npx tsx scripts/reel-voice-sample.ts */
async function main() {
  const started = Date.now();
  const { audio, words } = await edgeTts.synthesize('Xin chào, đây là bài thử giọng đọc cho Reel.', 'vi-VN-HoaiMyNeural');
  await writeFile('storage/reel-voice-sample.mp3', audio);
  console.log(`${Date.now() - started} ms, ${audio.length} bytes, ${words.length} words:`, words.map((w) => w.text).join(' '));
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
