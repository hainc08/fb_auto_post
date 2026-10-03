import { writeFile } from 'node:fs/promises';
import { reelSelfCheck } from '../src/lib/reel/self-check';

/** Manual run of the host check: npx tsx scripts/reel-check.ts (writes storage/reel-check.mp4) */
async function main() {
  const { file, ...report } = await reelSelfCheck();
  if (file) await writeFile('storage/reel-check.mp4', file);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
main();
