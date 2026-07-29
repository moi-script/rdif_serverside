/**
 * Asserts the anti-passback behaviour in
 * docs/superpowers/specs/2026-07-29-anti-passback-design.md.
 *
 * Requires: `npm run dev` running, and `npm run seed:test` already applied.
 * Run with: npm run verify:passback
 */
import { lastResetBoundary } from '../utils/occupancyWindow';

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
  console.log('All anti-passback checks passed.');
}

/** Builds a local-time Date on a fixed calendar day, so assertions read clearly. */
function at(day: number, hh: number, mm: number): Date {
  return new Date(2026, 6, day, hh, mm, 0, 0); // month 6 = July
}

async function main(): Promise<void> {
  console.log('\n== reset boundary ==');

  // Before the cutoff: the boundary is YESTERDAY's occurrence.
  expectEqual(
    'morning tap resolves to yesterday 23:00',
    lastResetBoundary(at(15, 7, 5), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // After the cutoff: the boundary is TODAY's occurrence.
  expectEqual(
    'late-night tap resolves to today 23:00',
    lastResetBoundary(at(15, 23, 30), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // Exactly at the cutoff counts as "at or before", so it is today's.
  expectEqual(
    'a tap exactly at the cutoff resolves to today',
    lastResetBoundary(at(15, 23, 0), '23:00').getTime(),
    at(15, 23, 0).getTime()
  );

  // One minute before the cutoff is still the previous day's boundary. This is
  // the off-by-one the helper exists to get right.
  expectEqual(
    'one minute before the cutoff resolves to yesterday',
    lastResetBoundary(at(15, 22, 59), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // Midnight is the hardest case: 00:30 with a 23:00 cutoff must look BACK to
  // the previous calendar day, not forward to tonight.
  expectEqual(
    'after midnight resolves to the previous evening',
    lastResetBoundary(at(15, 0, 30), '23:00').getTime(),
    at(14, 23, 0).getTime()
  );

  // A midnight cutoff must not degenerate: at 00:00 the boundary is now.
  expectEqual(
    'a 00:00 cutoff resolves to today at midnight',
    lastResetBoundary(at(15, 0, 0), '00:00').getTime(),
    at(15, 0, 0).getTime()
  );

  // The default-parameter path is contract for Tasks 4, 5 and 7, so exercise it.
  expectEqual(
    'omitting resetTime uses the configured default',
    lastResetBoundary(at(15, 7, 5)).getTime(),
    lastResetBoundary(at(15, 7, 5), '23:00').getTime()
  );

  summary();
}

main().catch((err) => {
  console.error('[verify:passback] failed', err);
  process.exit(1);
});
