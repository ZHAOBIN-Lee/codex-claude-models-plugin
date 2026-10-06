"""Real SQLite/filesystem tests; model calls and user-home writes are forbidden."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import selectors
import shlex
import subprocess
import tempfile
import time
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/thread_migration.py'
spec = importlib.util.spec_from_file_location('thread_migration', MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
THREAD = '01a106aa-c6e6-7453-8042-7e14e3cf09b4'
BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='migration-test-')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.home.mkdir()
        self.rollout = self.home/'sessions/test.jsonl'
        self.rollout.parent.mkdir()
        self.rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':THREAD,'model_provider':'openai'}})+'\n'+json.dumps({'type':'response_item','payload':{'text':'PRIVATE_FIXTURE_HISTORY'}})+'\n')
        (self.home/'config.toml').write_text('model_provider = "codex_model_router"\n[model_providers.codex_model_router]\nbase_url = "http://127.0.0.1:1/v1"\n')
        self.db = self.home/'state_5.sqlite'
        self.conn = sqlite3.connect(str(self.db))
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('PRAGMA wal_autocheckpoint=0')
        self.conn.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER)')
        self.conn.execute('INSERT INTO threads VALUES (?,?,?,?,?)',(THREAD,'openai',str(self.rollout),str(self.root),0))
        self.conn.execute('INSERT INTO threads VALUES (?,?,?,?,?)',('other','openai','unused',str(self.root),0))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_plan_reads_current_provider_without_mutating_any_file(self):
        # A real SQLite WAL reader updates transient -shm read marks even in mode=ro.
        # The committed database/WAL and all user/config/history files must remain unchanged.
        before = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.home.rglob('*') if p.is_file() and not p.name.endswith('-shm')}
        info = m.plan(self.home, THREAD)
        self.assertEqual(info.get('source_provider'), 'openai')
        self.assertEqual(info.get('target_provider'), 'codex_model_router')
        self.assertNotIn('PRIVATE_FIXTURE_HISTORY',json.dumps(info))
        after = {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.home.rglob('*') if p.is_file() and not p.name.endswith('-shm')}
        self.assertEqual(after,before)

    def test_unknown_or_archived_thread_stops_before_backup(self):
        with self.assertRaises(m.MigrationError):
            m.plan(self.home,'01a106aa-c6e6-7453-8042-7e14e3cf0999')
        self.conn.execute('UPDATE threads SET archived=1 WHERE id=?',(THREAD,));self.conn.commit()
        with self.assertRaises(m.MigrationError):m.plan(self.home,THREAD)

    def test_rollout_outside_home_is_rejected(self):
        outside=self.root/'outside.jsonl';outside.write_text(self.rollout.read_text())
        self.conn.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(outside),THREAD));self.conn.commit()
        with self.assertRaises(m.MigrationError):m.plan(self.home,THREAD)

    def test_running_desktop_or_codex_backend_refuses_migration(self):
        for line in [f'123 {BINARY} app-server --stdio','456 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT']:
            with self.subTest(line=line),self.assertRaises(m.MigrationError):m.ensure_quiet([line],BINARY)
        m.ensure_quiet(['123 node /Users/fixture/.codex/claude-models/bridge.mjs'],BINARY)

    def test_backup_includes_committed_wal_and_private_file_modes(self):
        self.conn.execute('UPDATE threads SET model_provider="wal-value" WHERE id="other"');self.conn.commit()
        info=m.plan(self.home,THREAD)
        result=m.backup(info,self.root/'backups')
        self.assertTrue(result.get('manifest'))
        manifest=json.loads(Path(result['manifest']).read_text())
        snapshot=Path(result['manifest']).parent/'state.sqlite'
        with sqlite3.connect(str(snapshot)) as db:
            self.assertEqual(db.execute('SELECT model_provider FROM threads WHERE id="other"').fetchone()[0],'wal-value')
        self.assertEqual((snapshot.stat().st_mode & 0o777),0o600)
        self.assertEqual((snapshot.parent.stat().st_mode & 0o777),0o700)
        history=snapshot.parent/'rollout.jsonl'
        self.assertEqual(history.read_bytes(),self.rollout.read_bytes())
        self.assertEqual(manifest['original_provider'],'openai')
        self.assertNotIn('PRIVATE_FIXTURE_HISTORY',json.dumps(result))

    def test_backup_failure_leaves_no_success_manifest(self):
        info=m.plan(self.home,THREAD)
        self.rollout.unlink()
        with self.assertRaises(m.MigrationError):m.backup(info,self.root/'backups')
        self.assertFalse(list((self.root/'backups').glob('*/manifest.json')))

    def test_verify_detects_history_loss_and_unrelated_thread_change(self):
        b=m.backup(m.plan(self.home,THREAD),self.root/'backups')['manifest']
        self.conn.execute('UPDATE threads SET model_provider="codex_model_router" WHERE id=?',(THREAD,));self.conn.commit()
        self.assertEqual(m.verify(b).get('status'),'verified')
        self.rollout.write_text(self.rollout.read_text().replace('PRIVATE_FIXTURE_HISTORY','LOST_HISTORY'))
        with self.assertRaises(m.MigrationError):m.verify(b)
        self.rollout.write_bytes((Path(b).parent/'rollout.jsonl').read_bytes())
        self.conn.execute('UPDATE threads SET model_provider="changed" WHERE id="other"');self.conn.commit()
        with self.assertRaises(m.MigrationError):m.verify(b)

    def test_verify_detects_config_or_backup_tampering(self):
        b=m.backup(m.plan(self.home,THREAD),self.root/'backups')['manifest']
        self.conn.execute('UPDATE threads SET model_provider="codex_model_router" WHERE id=?',(THREAD,));self.conn.commit()
        self.assertEqual(m.verify(b).get('status'),'verified')
        config=self.home/'config.toml';previous=config.read_bytes();config.write_bytes(previous+b'\n# new setting\n')
        with self.assertRaises(m.MigrationError):m.verify(b)
        config.write_bytes(previous)
        (Path(b).parent/'rollout.jsonl').write_text('broken backup')
        with self.assertRaises(m.MigrationError):m.verify(b)

    def test_migrate_refuses_live_backend_before_creating_backup(self):
        with self.assertRaises(m.MigrationError):
            m.migrate(self.home,THREAD,BINARY,self.root/'backups',process_probe=lambda:[f'123 {BINARY} app-server --stdio'],health_probe=lambda _:True)
        self.assertFalse((self.root/'backups').exists())

    def test_migrate_refuses_unhealthy_router_before_creating_backup(self):
        with self.assertRaises(m.MigrationError):
            m.migrate(self.home,THREAD,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:False)
        self.assertFalse((self.root/'backups').exists())

    def test_existing_migration_lock_prevents_any_backup(self):
        (self.home/'thread-provider-migration.lock').write_text('other operation')
        with self.assertRaises(m.MigrationError):
            m.migrate(self.home,THREAD,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        self.assertFalse((self.root/'backups').exists())
        self.assertEqual((self.home/'thread-provider-migration.lock').read_text(),'other operation')

    def test_wrong_provider_and_mismatched_history_identity_are_refused(self):
        with self.assertRaises(m.MigrationError):m.plan(self.home,THREAD,'unregistered-provider')
        self.rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':'different-chat'}})+'\n')
        with self.assertRaises(m.MigrationError):m.plan(self.home,THREAD)

    def test_cli_refuses_unverified_codex_version_before_writes(self):
        result=subprocess.run(['python3',str(MODULE),'migrate','--home',str(self.home),'--thread-id',THREAD,
            '--backup-dir',str(self.root/'backups'),'--codex-bin','/usr/bin/false'],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,1)
        self.assertEqual(json.loads(result.stdout)['reason'],'codex_version_not_verified')
        self.assertFalse((self.root/'backups').exists())

    def version_binary(self, output, exit_code=0):
        binary=self.root/'version-only-cli'
        binary.write_text("#!/bin/sh\nprintf '%s\\n' "+shlex.quote(output)+"\nexit "+str(exit_code)+"\n")
        binary.chmod(0o700)
        return binary

    def test_version_guard_accepts_both_verified_desktop_releases(self):
        for version in ('0.160.0','0.160.1'):
            with self.subTest(version=version):
                try:actual=m.check_binary(self.version_binary('codex-cli '+version))
                except m.MigrationError as error:self.fail('verified desktop release refused: '+str(error))
                self.assertEqual(actual,version)

    def test_unverified_release_reports_actual_version_without_writes(self):
        for version in ('0.160.2','0.160.10','0.161.0'):
            with self.subTest(version=version):
                result=subprocess.run(['python3',str(MODULE),'migrate','--home',str(self.home),'--thread-id',THREAD,
                    '--backup-dir',str(self.root/'backups'),'--codex-bin',str(self.version_binary('codex-cli '+version))],
                    capture_output=True,text=True,timeout=5)
                self.assertEqual(result.returncode,1)
                report=json.loads(result.stdout)
                self.assertEqual(report['reason'],'codex_version_not_verified')
                self.assertEqual(report.get('binary_check',{}).get('actual_version'),version)
                self.assertEqual(report.get('binary_check',{}).get('status'),'unsupported_version')
                self.assertFalse((self.root/'backups').exists())

    def test_version_guard_rejects_malformed_or_failed_version_command(self):
        for output,code,status in [('codex-cli 0.160.1 unexpected',0,'unrecognized_version_output'),
                                   ('codex-cli 0.160.1',1,'version_command_failed')]:
            with self.subTest(output=output,code=code),self.assertRaises(m.MigrationError) as raised:
                m.check_binary(self.version_binary(output,code))
            self.assertEqual(getattr(raised.exception,'binary_check',{}).get('status'),status)

    def test_missing_binary_is_reported_without_writes(self):
        result=subprocess.run(['python3',str(MODULE),'migrate','--home',str(self.home),'--thread-id',THREAD,
            '--backup-dir',str(self.root/'backups'),'--codex-bin',str(self.root/'missing-cli')],
            capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,1)
        report=json.loads(result.stdout)
        self.assertEqual(report['reason'],'codex_version_not_verified')
        self.assertEqual(report.get('binary_check',{}).get('status'),'version_command_unavailable')
        self.assertFalse((self.root/'backups').exists())


class FixtureRpc:
    """Test utility talks to actual Codex. No model/HTTP mocks."""
    def __init__(self,home,cwd):
        self.p=subprocess.Popen([BINARY,'app-server','--stdio'],cwd=cwd,env={**os.environ,'CODEX_HOME':str(home)},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        self.sel=selectors.DefaultSelector();self.sel.register(self.p.stdout,selectors.EVENT_READ)
        self.buffer=b'';self.id=0
        self.call('initialize',{'clientInfo':{'name':'migration-fixture','version':'0.2.0'},'capabilities':{'experimentalApi':True}})
        self.p.stdin.write(b'{"method":"initialized"}\n');self.p.stdin.flush()
    def call(self,method,params):
        self.id+=1;self.p.stdin.write((json.dumps({'id':self.id,'method':method,'params':params})+'\n').encode());self.p.stdin.flush()
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            while b'\n' in self.buffer:
                line,self.buffer=self.buffer.split(b'\n',1)
                if not line:continue
                message=json.loads(line)
                if message.get('id')==self.id:
                    if 'error' in message:raise RuntimeError(message['error'])
                    return message['result']
            if self.sel.select(.1):
                data=os.read(self.p.stdout.fileno(),65536)
                if not data:raise RuntimeError('fixture Codex exited')
                self.buffer+=data
        raise TimeoutError(method)
    def close(self):
        self.p.terminate();self.p.wait(timeout=5);self.p.stdin.close();self.p.stdout.close();self.sel.close()


@unittest.skipUnless(Path(BINARY).is_file(),'current desktop Codex not present')
class NativeMigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='migration-native-test-')
        self.root=Path(self.temp.name).resolve();self.home=self.root/'home';self.home.mkdir()
        (self.home/'config.toml').write_text('model = "gpt-6.1-sol"\nmodel_provider = "codex_model_router"\n[features]\nplugins = false\napps = false\nremote_plugin = false\n[model_providers.codex_model_router]\nname = "Fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n')
        c=FixtureRpc(self.home,self.root)
        try:
            response=c.call('thread/start',{'model':'gpt-6.1-sol','modelProvider':'openai','cwd':str(self.root),'sandbox':'read-only','approvalPolicy':'never','ephemeral':False})
            self.thread=response['thread']['id']
            c.call('thread/inject_items',{'threadId':self.thread,'items':[{'type':'message','role':'user','content':[{'type':'input_text','text':'NATIVE_HISTORY_TEST_4721'}]}]})
            # Native acknowledgements can precede the asynchronous SQLite/history
            # flush. Read the fixture back before terminating its app-server.
            deadline=time.monotonic()+5
            while True:
                ready=False
                try:
                    databases=sorted(self.home.glob('state_*.sqlite'),key=lambda p:int(p.stem.split('_')[-1]))
                    if databases:
                        with sqlite3.connect(databases[-1].resolve().as_uri()+'?mode=ro',uri=True,timeout=.1) as db:
                            row=db.execute('SELECT rollout_path, model_provider FROM threads WHERE id=?',(self.thread,)).fetchone()
                        ready=bool(row and row[1]=='openai' and 'NATIVE_HISTORY_TEST_4721' in Path(row[0]).read_text())
                except (sqlite3.Error,OSError):pass
                if ready:break
                if time.monotonic()>=deadline:raise AssertionError('native fixture did not persist its thread and injected history')
                time.sleep(.02)
        finally:c.close()
    def tearDown(self):self.temp.cleanup()

    def test_actual_codex_migrates_persists_and_rolls_back_same_thread(self):
        # Environment-only health/process probes are replaced because no live model service is used.
        try:m.check_binary(BINARY)
        except m.MigrationError as error:self.fail('current desktop version gate refused native migration: '+str(error))
        result=m.migrate(self.home,self.thread,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        self.assertEqual(result.get('status'),'migrated')
        self.assertEqual(m.plan(self.home,self.thread)['source_provider'],'codex_model_router')
        self.assertTrue(m.verify(result['manifest']).get('history_preserved'))
        duplicate=m.migrate(self.home,self.thread,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        self.assertEqual(duplicate.get('status'),'already_target')
        returned=m.rollback(result['manifest'],BINARY,process_probe=lambda:[])
        self.assertEqual(returned.get('status'),'rolled_back')
        self.assertEqual(m.plan(self.home,self.thread)['source_provider'],'openai')
        self.assertIn('NATIVE_HISTORY_TEST_4721',Path(m.plan(self.home,self.thread)['rollout']).read_text())

    def test_failed_codex_does_not_report_success_and_retains_backup(self):
        with self.assertRaises(m.MigrationError):
            m.migrate(self.home,self.thread,'/usr/bin/false',self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        self.assertEqual(m.plan(self.home,self.thread)['source_provider'],'openai')
        self.assertEqual(len(list((self.root/'backups').glob('*/manifest.json'))),1)

    def test_rollback_preserves_later_changes_to_other_chats(self):
        result=m.migrate(self.home,self.thread,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        c=FixtureRpc(self.home,self.root)
        try:
            other=c.call('thread/start',{'cwd':str(self.root),'sandbox':'read-only','approvalPolicy':'never','ephemeral':False})['thread']['id']
            c.call('thread/inject_items',{'threadId':other,'items':[{'type':'message','role':'user','content':[{'type':'input_text','text':'NEW_OTHER_CHAT_HISTORY'}]}]})
        finally:c.close()
        dbpath=Path(m.plan(self.home,self.thread)['database'])
        with sqlite3.connect(str(dbpath)) as db:
            db.execute('UPDATE threads SET title="new unrelated user work" WHERE id=?',(other,))
        config=self.home/'config.toml';config.write_text(config.read_text()+'\n# later user config\n')
        rolled=m.rollback(result['manifest'],BINARY,process_probe=lambda:[])
        self.assertEqual(rolled['status'],'rolled_back')
        with sqlite3.connect(str(dbpath)) as db:
            self.assertEqual(db.execute('SELECT title FROM threads WHERE id=?',(other,)).fetchone()[0],'new unrelated user work')
        self.assertIn('# later user config',config.read_text())

    def test_failed_rollback_records_unknown_completion_instead_of_old_success(self):
        result=m.migrate(self.home,self.thread,BINARY,self.root/'backups',process_probe=lambda:[],health_probe=lambda _:True)
        with self.assertRaises(m.MigrationError):m.rollback(result['manifest'],'/usr/bin/false',process_probe=lambda:[])
        journal=json.loads((Path(result['manifest']).parent/'operation-result.json').read_text())
        self.assertEqual(journal.get('status'),'rollback_failed')
        self.assertEqual(journal.get('completion'),'unknown')
        self.assertEqual(m.plan(self.home,self.thread)['source_provider'],'codex_model_router')

if __name__ == '__main__':unittest.main()
