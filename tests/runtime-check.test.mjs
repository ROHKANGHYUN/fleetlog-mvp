import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('apps/car-android/scripts/check-runtime.py');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chagok-runtime-check-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sdk = join(directory, 'sdk'), java = join(directory, 'java'), avd = join(directory, 'avd');
  const marker = join(directory, 'adb-invoked');
  for (const name of ['platforms/android-35', 'build-tools/35.0.0', 'platform-tools']) mkdirSync(join(sdk, name), { recursive: true });
  mkdirSync(join(java, 'bin'), { recursive: true });mkdirSync(avd);
  writeFileSync(join(java, 'bin/java'), '#!/bin/sh\nprintf \'openjdk version "17.0.15"\\n\' >&2\n', { mode: 0o755 });
  writeFileSync(join(java, 'bin/gradle'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(sdk, 'platforms/android-35/android.jar'), 'fixture');
  writeFileSync(join(sdk, 'build-tools/35.0.0/aapt2'), 'fixture');
  writeFileSync(join(sdk, 'platform-tools/adb'), `#!/bin/sh
touch '${marker}'
if [ "$1" = 'devices' ]; then
  printf 'List of devices attached\nemulator-test device product:test\npersonal-device unauthorized\n'
elif [ "$1" = '-s' ] && [ "$2" = 'emulator-test' ]; then
  printf '35\n'
else
  exit 1
fi
`, { mode: 0o755 });
  return { sdk, java, avd, marker, args: ['--sdk-root', sdk, '--java-home', java, '--avd-home', avd] };
}
function run(args) {
  const fixtureJava = args[args.indexOf('--java-home') + 1];
  const result = spawnSync('python3', [script, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(fixtureJava, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('build prerequisites are distinct from runtime readiness and default inventory never invokes adb', t => {
  const f = fixture(t), report = run(f.args);
  assert.equal(report.build_prerequisites_found, true);
  assert.equal(report.gradle.version_verified, false);
  assert.equal(report.components.emulator, false);
  assert.equal(report.android_runtime, 'unconfirmed');
  assert.equal(report.pleos_service, 'unconfirmed');
  assert.equal(report.devices.probed, false);
  assert.equal(report.registered_avds.length, 0);
  assert.equal(existsSync(f.marker), false);
  assert.ok(report.blockers.some(message => message.includes('No emulator executable')));
  assert.ok(report.disks.sdk.free_bytes > 0);
});

test('an explicit adb inventory never silently selects a personal or test device', t => {
  const f = fixture(t), report = run([...f.args, '--probe-adb']);
  assert.equal(existsSync(f.marker), true);
  assert.equal(report.devices.items.length, 2);
  assert.equal(report.devices.selected_serial, null);
  assert.equal(report.android_runtime, 'unconfirmed');
  assert.ok(report.blockers.some(message => message.includes('Device selection required')));
});

test('only an explicitly named available device is queried and still does not imply Pleos service readiness', t => {
  const f = fixture(t), report = run([...f.args, '--probe-adb', '--serial', 'emulator-test']);
  assert.equal(report.android_runtime, 'explicit-device-selected');
  assert.equal(report.devices.selected_api, '35');
  assert.equal(report.pleos_service, 'unconfirmed');
  const unavailable = run([...f.args, '--probe-adb', '--serial', 'personal-device']);
  assert.equal(unavailable.android_runtime, 'unconfirmed');
  assert.ok(unavailable.blockers.some(message => message.includes('offline or unauthorized')));
});

test('an AVD registration without executable and image is inventory, never successful installation or execution', t => {
  const f = fixture(t);
  writeFileSync(join(f.avd, 'Pleos-test.ini'), 'path=/not-installed\n');
  const report = run(f.args);
  assert.equal(report.registered_avds[0].name, 'Pleos-test');
  assert.equal(report.components.emulator, false);
  assert.equal(report.android_runtime, 'unconfirmed');
  assert.equal(report.pleos_service, 'unconfirmed');
});

test('an adb query failure is an unavailable inventory, not an empty device result', t => {
  const f = fixture(t);
  writeFileSync(join(f.sdk, 'platform-tools/adb'), '#!/bin/sh\nprintf \'cannot connect to daemon\\n\' >&2\nexit 1\n', { mode: 0o755 });
  const report = run([...f.args, '--probe-adb']);
  assert.equal(report.devices.command_exit_code, 1);
  assert.equal(report.devices.error, 'cannot connect to daemon');
  assert.equal(report.android_runtime, 'unconfirmed');
  assert.ok(report.blockers.some(message => message.includes('inventory failed')));
  assert.equal(report.blockers.some(message => message.includes('No connected device')), false);
});
