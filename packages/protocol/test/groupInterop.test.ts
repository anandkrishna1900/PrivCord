import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GroupLog } from '../src';

// Written by the Android unit tests (GroupVectorsTest "Kotlin signed events ..."). Run
// `gradle :app:testDebugUnitTest` in apps/android first; without the file these checks are skipped.
const file = new URL('../../../apps/android/app/build/interop/kotlin-group-events.json', import.meta.url);

describe.skipIf(!existsSync(file))('group events signed by the Android app', () => {
  const k = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  it('every Kotlin-signed event is accepted and effective in the TypeScript GroupLog', async () => {
    const log = new GroupLog(k.groupId);
    for (const e of k.events) expect(await log.add(e)).toBe('applied');
    expect(k.events).toHaveLength(5);
    for (const e of k.events) expect(log.isEffective(e.eventId)).toBe(true);
    expect([...log.state()!.members.keys()].sort()).toEqual(k.roster);
    expect(log.state()!.name).toBe('Renamed by Kotlin');
  });

  it('a tampered Kotlin event is rejected', async () => {
    const log = new GroupLog(k.groupId);
    const rename = k.events.find((e: { type: string }) => e.type === 'rename');
    for (const e of k.events) if (e !== rename) await log.add(e);
    expect(await log.add({ ...rename, name: 'Hacked' })).toBe('invalid');
  });
});
