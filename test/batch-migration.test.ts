import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('batch migration changes only the provider column, reverts on failure and rolls back', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'batch_migration_test.py', '-v'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
