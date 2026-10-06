"""Batch migration tests on real SQLite files. Native resume, process and health probes are replaced; no model calls."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/batch_migration.py'
spec = importlib.util.spec_from_file_location('batch_migration', MODULE)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
QUIET = dict(probe=lambda: [], health=lambda _: True)
SUBAGENT = '{"subagent":{"parent":"x"}}'


class BatchMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='batch-migration-test-')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        (self.home / 'config.toml').write_text(
            'model_provider = "codex_model_router"\n[model_providers.codex_model_router]\nbase_url = "http://127.0.0.1:1/v1"\n')
        self.db = self.home / 'state_5.sqlite'
        con = sqlite3.connect(str(self.db))
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, cwd TEXT, '
                    'archived INTEGER, source TEXT, title TEXT)')
        rows = [('a-chat', 'openai', 0, 'vscode'), ('b-chat', 'openai', 0, 'cli'),
                ('c-archived', 'openai', 1, 'vscode'), ('d-sub', 'openai', 0, SUBAGENT),
                ('e-router', 'codex_model_router', 0, 'vscode'), ('f-other', 'aivr', 0, 'vscode')]
        for i, provider, archived, source in rows:
            con.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?)',
                        (i, provider, str(self.root / (i + '.jsonl')), str(self.root), archived, source, 'title ' + i))
        con.commit()
        con.close()  # Codex fully quit: no -shm left, which once broke read-only opening
        self.resumed = []
        self.original_resume = b.tm.cold_resume
        b.tm.cold_resume = lambda info, binary, provider=None: self.resumed.append(info['thread_id'])

    def tearDown(self):
        b.tm.cold_resume = self.original_resume
        self.temp.cleanup()

    def providers(self):
        with sqlite3.connect(str(self.db)) as con:
            return dict(con.execute('SELECT id, model_provider FROM threads'))

    def migrate(self, **kw):
        args = dict(include_subagents=True, include_archived=True, sample=3, **QUIET)
        args.update(kw)
        return b.migrate(self.home, BINARY, self.root / 'backups', **args)

    def test_plan_scope_flags_and_no_writes(self):
        before = self.db.read_bytes()
        self.assertEqual(b.plan(self.home)['threads'], ['a-chat', 'b-chat'])
        self.assertEqual(b.plan(self.home, include_subagents=True, include_archived=True)['threads'],
                         ['a-chat', 'b-chat', 'c-archived', 'd-sub'])
        self.assertEqual(self.db.read_bytes(), before)

    def test_plan_refuses_without_router_config(self):
        (self.home / 'config.toml').write_text('model_provider = "openai"\n')
        with self.assertRaises(b.Error):
            b.plan(self.home)

    def test_live_backend_or_unhealthy_router_stops_before_backup(self):
        with self.assertRaises(b.Error):
            self.migrate(probe=lambda: ['123 %s app-server --stdio' % BINARY])
        with self.assertRaises(b.Error):
            self.migrate(health=lambda _: False)
        self.assertFalse((self.root / 'backups').exists())
        self.assertEqual(self.providers()['a-chat'], 'openai')

    def test_migrates_only_provider_column_and_samples_open_user_chats(self):
        result = self.migrate(check=['c-archived', 'b-chat'])
        self.assertEqual(result['status'], 'migrated')
        self.assertEqual(result['count'], 4)
        p = self.providers()
        for i in ('a-chat', 'b-chat', 'c-archived', 'd-sub', 'e-router'):
            self.assertEqual(p[i], 'codex_model_router')
        self.assertEqual(p['f-other'], 'aivr')
        # archived and sub-agent chats are never cold-resumed; --check order is kept
        self.assertEqual(self.resumed, ['b-chat', 'a-chat'])
        folder = Path(result['manifest']).parent
        self.assertEqual(json.loads((folder / 'operation-result.json').read_text())['status'], 'migrated')
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.migrate()['status'], 'nothing_to_migrate')

    def test_failed_sample_reverts_every_row_and_names_the_chat(self):
        def fail(info, binary, provider=None):
            raise b.Error('native_rpc_error:-32600')
        b.tm.cold_resume = fail
        with self.assertRaises(b.Error) as raised:
            self.migrate()
        self.assertTrue(str(raised.exception).startswith('sample_resume_failed:a-chat:'))
        p = self.providers()
        for i in ('a-chat', 'b-chat', 'c-archived', 'd-sub'):
            self.assertEqual(p[i], 'openai')
        self.assertEqual(p['e-router'], 'codex_model_router')
        journal = json.loads((Path(raised.exception.manifest).parent / 'operation-result.json').read_text())
        self.assertEqual(journal['status'], 'failed_and_reverted')
        self.assertFalse((self.home / 'thread-provider-migration.lock').exists())

    def test_rollback_restores_listed_rows_and_keeps_later_edits(self):
        result = self.migrate()
        with sqlite3.connect(str(self.db)) as con:
            con.execute("UPDATE threads SET title = 'renamed later' WHERE id = 'a-chat'")
        rolled = b.rollback(result['manifest'], BINARY, probe=lambda: [])
        self.assertEqual(rolled['status'], 'rolled_back')
        p = self.providers()
        for i in ('a-chat', 'b-chat', 'c-archived', 'd-sub'):
            self.assertEqual(p[i], 'openai')
        self.assertEqual(p['e-router'], 'codex_model_router')
        with sqlite3.connect(str(self.db)) as con:
            self.assertEqual(con.execute("SELECT title FROM threads WHERE id = 'a-chat'").fetchone()[0], 'renamed later')

    def test_rollback_refuses_tampered_backup(self):
        result = self.migrate()
        (Path(result['manifest']).parent / 'config.toml').write_text('tampered')
        with self.assertRaises(b.Error):
            b.rollback(result['manifest'], BINARY, probe=lambda: [])
        self.assertEqual(self.providers()['a-chat'], 'codex_model_router')


if __name__ == '__main__':
    unittest.main()
