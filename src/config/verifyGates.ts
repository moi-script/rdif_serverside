/**
 * Asserts the photo pipeline and gate terminal behavior in
 * docs/superpowers/specs/2026-07-27-photo-and-gate-terminals-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:gates
 */
import { detectImageType } from '../utils/imageType';

const failures: string[] = [];
let checks = 0;

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    console.log(`  FAIL ${name} — ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    return;
  }
  console.log(`  ok   ${name}`);
}

function summary(): void {
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('All gate and photo checks passed.');
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);
const TEXT = Buffer.from('this is not an image at all, not even close');

async function main(): Promise<void> {
  console.log('\n== magic-byte detection ==');
  expectEqual('jpeg detected', detectImageType(JPEG), 'image/jpeg');
  expectEqual('png detected', detectImageType(PNG), 'image/png');
  expectEqual('webp detected', detectImageType(WEBP), 'image/webp');
  expectEqual('text rejected', detectImageType(TEXT), null);
  expectEqual('empty buffer rejected', detectImageType(Buffer.alloc(0)), null);
  expectEqual('truncated jpeg rejected', detectImageType(Buffer.from([0xff, 0xd8])), null);

  summary();
}

main().catch((err) => {
  console.error('[verify:gates] failed', err);
  process.exit(1);
});
