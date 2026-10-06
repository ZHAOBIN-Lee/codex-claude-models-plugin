import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('one-thread migration preserves WAL/history and verifies native resume/rollback', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'thread_migration_test.py', '-v'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
