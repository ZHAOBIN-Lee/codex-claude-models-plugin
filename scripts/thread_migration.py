"""One-thread native Provider migration. Python 3.9+, no model calls."""
import hashlib
import argparse
from contextlib import contextmanager, closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import selectors
import subprocess
import time
import urllib.request
import uuid

class MigrationError(RuntimeError):
    pass

# Each release has passed actual isolated native migration/persistence/rollback.
VERIFIED_CODEX_VERSIONS = ('0.160.0', '0.160.1')

def digest(path, limit=None):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        remaining=limit
        while remaining is None or remaining>0:
            data=f.read(1024*1024 if remaining is None else min(1024*1024,remaining))
            if not data:break
            h.update(data)
            if remaining is not None:remaining-=len(data)
    if remaining is not None and remaining!=0:raise MigrationError('history_shorter_than_backup')
    return h.hexdigest()

def readonly_db(path, immutable=False):
    # immutable is only valid for our completed static backup, never the live source/WAL.
    suffix='?mode=ro&immutable=1' if immutable else '?mode=ro'
    return sqlite3.connect(Path(path).resolve().as_uri()+suffix,uri=True,timeout=5)

def other_threads(db,thread_id):
    h=hashlib.sha256()
    for row in db.execute('SELECT * FROM threads WHERE id != ? ORDER BY id',(thread_id,)):
        h.update(repr(tuple(row)).encode())
        h.update(b'\n')
    return h.hexdigest()

def plan(home, thread_id, target='codex_model_router'):
    if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',thread_id):raise MigrationError('exact_thread_uuid_required')
    if target not in ('openai','codex_model_router'):raise MigrationError('provider_not_supported')
    home=Path(home).resolve()
    config=home/'config.toml'
    try:
        text=config.read_text()
        if not re.search(r'^\[model_providers\.codex_model_router\]\s*$',text,re.M):raise MigrationError('router_not_configured')
        dbs=sorted(home.glob('state_*.sqlite'),key=lambda p:int(p.stem.split('_')[-1]))
        if not dbs:raise MigrationError('state_database_missing')
        database=dbs[-1]
        if database.is_symlink():raise MigrationError('database_symlink_refused')
        db=readonly_db(database)
        try:
            db.row_factory=sqlite3.Row
            row=db.execute('SELECT * FROM threads WHERE id=?',(thread_id,)).fetchone()
            if row is None:raise MigrationError('thread_not_found')
            row=dict(row)
            if row.get('archived'):raise MigrationError('archived_thread_refused')
            source=row['model_provider']
            if source not in ('openai','codex_model_router'):raise MigrationError('source_provider_not_supported')
            rollout=Path(row['rollout_path']).resolve()
            try:rollout.relative_to(home)
            except ValueError:raise MigrationError('rollout_outside_home')
            if not rollout.is_file():raise MigrationError('rollout_missing')
            with rollout.open() as f:meta=json.loads(f.readline())
            if meta.get('type')!='session_meta' or meta.get('payload',{}).get('id')!=thread_id:raise MigrationError('rollout_identity_mismatch')
            # SQLite is authoritative for the effective route; creation-time JSONL can differ.
            return {'home':str(home),'database':str(database),'config':str(config),
                'config_sha256':digest(config),'thread_id':thread_id,'source_provider':source,
                'target_provider':target,'rollout':str(rollout),'history_size':rollout.stat().st_size,
                'history_sha256':digest(rollout),'other_threads_sha256':other_threads(db,thread_id),
                'cwd':row.get('cwd') or str(home),'needs_migration':source!=target}
        finally:db.close()
    except (OSError,sqlite3.Error,ValueError,KeyError) as e:
        raise MigrationError('plan_read_failed:'+type(e).__name__) from None

def ensure_quiet(processes, binary):
    for line in processes:
        if (re.search(r'\bapp-server\b',line) and (str(binary) in line or re.search(r'[/ ]codex(?:\.exe)?\b',line))
                or re.search(r'/(?:ChatGPT|Codex)\.app/Contents/MacOS/(?:ChatGPT|Codex)(?:\s|$)',line)):
            raise MigrationError('desktop_or_codex_backend_still_running')

def backup(info, destination):
    folder=None
    try:
        current=plan(info['home'],info['thread_id'],info['target_provider'])
        if current!=info:raise MigrationError('plan_changed_before_backup')
        destination=Path(destination)
        if destination.is_symlink():raise MigrationError('backup_symlink_refused')
        destination.mkdir(parents=True,exist_ok=True)
        folder=destination/('thread-'+info['thread_id']+'-'+uuid.uuid4().hex)
        folder.mkdir(mode=0o700)
        source=readonly_db(info['database'])
        snapshot=folder/'state.sqlite'
        snapshot.touch(mode=0o600)
        target=sqlite3.connect(str(snapshot))
        try:source.backup(target)
        finally:target.close();source.close()
        for original,name in [(info['rollout'],'rollout.jsonl'),(info['config'],'config.toml')]:
            out=folder/name
            out.touch(mode=0o600)
            shutil.copyfile(original,out)
        if plan(info['home'],info['thread_id'],info['target_provider'])!=info:raise MigrationError('state_changed_during_backup')
        manifest={**info,'original_provider':info['source_provider'],
            'backups':{name:digest(folder/name) for name in ['state.sqlite','rollout.jsonl','config.toml']}}
        output=folder/'manifest.json'
        with output.open('x') as f:json.dump(manifest,f,indent=2)
        output.chmod(0o600)
        return {'manifest':str(output)}
    except (OSError,sqlite3.Error,MigrationError) as e:
        if folder is not None:(folder/'manifest.json').unlink(missing_ok=True)
        if isinstance(e,MigrationError):raise
        raise MigrationError('backup_failed:'+type(e).__name__) from None

def verify(manifest_path, expected=None):
    return _verify(manifest_path,expected)

def load_manifest(path):
    path=Path(path).resolve()
    try:
        manifest=json.loads(path.read_text())
        for name in ['state.sqlite','rollout.jsonl','config.toml']:
            if digest(path.parent/name)!=manifest['backups'][name]:raise MigrationError('backup_integrity_failed')
        if (manifest['history_sha256']!=manifest['backups']['rollout.jsonl']
                or manifest['config_sha256']!=manifest['backups']['config.toml']):raise MigrationError('manifest_integrity_failed')
        with closing(readonly_db(path.parent/'state.sqlite',immutable=True)) as db:
            row=db.execute('SELECT model_provider,rollout_path FROM threads WHERE id=?',(manifest['thread_id'],)).fetchone()
            if not row or row[0]!=manifest['original_provider'] or str(Path(row[1]).resolve())!=manifest['rollout']:raise MigrationError('manifest_identity_failed')
        return manifest
    except (OSError,KeyError,ValueError,sqlite3.Error):raise MigrationError('manifest_invalid') from None

def _verify(manifest_path,expected=None,baseline=None):
    manifest=load_manifest(manifest_path)
    expected=expected or manifest['target_provider']
    current=plan(manifest['home'],manifest['thread_id'],expected)
    reference=baseline or manifest
    if current['source_provider']!=expected:raise MigrationError('provider_not_persisted')
    if current['rollout']!=manifest['rollout']:raise MigrationError('rollout_path_changed')
    if digest(current['rollout'],manifest['history_size'])!=manifest['history_sha256']:raise MigrationError('history_integrity_failed')
    if current['config_sha256']!=reference['config_sha256']:raise MigrationError('configuration_changed')
    if current['other_threads_sha256']!=reference['other_threads_sha256']:raise MigrationError('other_threads_changed')
    return {'status':'verified','thread_id':current['thread_id'],'provider':expected,
        'history_preserved':True,'other_threads_preserved':True,'configuration_preserved':True,
        'manifest':str(Path(manifest_path).resolve())}

def processes():
    try:
        p=subprocess.run(['/bin/ps','-axo','pid=,args='],capture_output=True,text=True,timeout=5)
        if p.returncode!=0:raise MigrationError('process_inventory_unavailable')
        return p.stdout.splitlines()
    except (OSError,subprocess.TimeoutExpired):raise MigrationError('process_inventory_unavailable') from None

def router_health(info):
    try:
        text=Path(info['config']).read_text()
        section=re.search(r'^\[model_providers\.codex_model_router\]\s*\n([^\[]*)',text,re.M)
        if section is None:return False
        url=re.search(r'^base_url\s*=\s*"(http://127\.0\.0\.1:([0-9]+)/v1)"\s*$',section[1],re.M)
        if not url or not 1<=int(url[2])<=65535:return False
        token=(Path(info['home'])/'claude-models/token').read_text().strip()
        if not token:return False
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        request=urllib.request.Request(url[1][:-3]+'/health',headers={'Authorization':'Bearer '+token})
        with opener.open(request,timeout=3) as response:
            data=json.loads(response.read(4096))
            return response.status==200 and data.get('service')=='codex-claude-models'
    except (OSError,ValueError):return False

@contextmanager
def operation_lock(home):
    lock=Path(home)/'thread-provider-migration.lock'
    try:fd=os.open(str(lock),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    except OSError:raise MigrationError('migration_lock_or_home_permission_failed') from None
    try:
        with os.fdopen(fd,'w') as f:f.write(str(os.getpid()))
        yield
    finally:lock.unlink()

class Rpc:
    def __init__(self,binary,home,cwd):
        self.p=None;self.sel=None;self.id=0;self.buffer=b''
        try:
            self.p=subprocess.Popen([str(binary),'app-server','--stdio'],cwd=cwd,
                env={**os.environ,'CODEX_HOME':str(home)},stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            self.sel=selectors.DefaultSelector();self.sel.register(self.p.stdout,selectors.EVENT_READ)
            self.call('initialize',{'clientInfo':{'name':'one-thread-provider-migration','version':'0.2.0'},'capabilities':{'experimentalApi':True}})
            self.send({'method':'initialized'})
        except (OSError,MigrationError):self.close();raise MigrationError('app_server_initialization_failed') from None
    def send(self,msg):
        try:self.p.stdin.write((json.dumps(msg)+'\n').encode());self.p.stdin.flush()
        except OSError:raise MigrationError('app_server_stdin_failed') from None
    def call(self,method,params):
        self.id+=1;self.send({'id':self.id,'method':method,'params':params})
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            while b'\n' in self.buffer:
                line,self.buffer=self.buffer.split(b'\n',1)
                if not line:continue
                try:message=json.loads(line)
                except ValueError:raise MigrationError('app_server_invalid_json') from None
                if message.get('id')==self.id:
                    if 'error' in message:raise MigrationError('native_rpc_error:'+str(message['error'].get('code','unknown')))
                    return message['result']
            if self.sel.select(.1):
                data=os.read(self.p.stdout.fileno(),65536)
                if not data:raise MigrationError('app_server_exited')
                self.buffer+=data
                if len(self.buffer)>4*1024*1024:raise MigrationError('app_server_response_too_large')
        raise MigrationError('native_rpc_timeout')
    def close(self):
        if self.p:
            if self.p.poll() is None:
                self.p.terminate()
                try:self.p.wait(timeout=5)
                except subprocess.TimeoutExpired:self.p.kill();self.p.wait(timeout=5)
            if self.p.stdin:self.p.stdin.close()
            if self.p.stdout:self.p.stdout.close()
        if self.sel:self.sel.close()

def cold_resume(info,binary,provider=None):
    c=Rpc(binary,info['home'],info['cwd'])
    try:
        params={'threadId':info['thread_id'],'excludeTurns':True}
        if provider is not None:params['modelProvider']=provider
        result=c.call('thread/resume',params)
        if result['thread']['id']!=info['thread_id']:raise MigrationError('native_thread_identity_mismatch')
        expected=provider or info['target_provider']
        if result.get('modelProvider')!=expected or result['thread'].get('modelProvider')!=expected:raise MigrationError('native_provider_mismatch')
    finally:c.close()

def save_result(manifest_path,result):
    out=Path(manifest_path).parent/'operation-result.json'
    temporary=out.with_suffix('.tmp')
    with temporary.open('w') as f:json.dump(result,f,indent=2)
    temporary.chmod(0o600);os.replace(str(temporary),str(out))

def migrate(home,thread_id,binary,destination,process_probe=None,health_probe=None):
    probe=process_probe or processes
    ensure_quiet(probe(),binary)
    info=plan(home,thread_id)
    if not info['needs_migration']:return {'status':'already_target','thread_id':thread_id,'provider':info['source_provider']}
    if not (health_probe or router_health)(info):raise MigrationError('router_health_not_verified')
    with operation_lock(info['home']):
        ensure_quiet(probe(),binary)
        manifest=backup(info,destination)['manifest']
        try:
            if plan(home,thread_id)!=info:raise MigrationError('state_changed_before_resume')
            ensure_quiet(probe(),binary)
            save_result(manifest,{'status':'started','thread_id':thread_id,'model_calls':0})
            cold_resume(info,binary,info['target_provider'])
            ensure_quiet(probe(),binary)
            _verify(manifest)
            cold_resume(info,binary)
            ensure_quiet(probe(),binary)
            result={**_verify(manifest),'status':'migrated','model_calls':0,'desktop_acceptance':'pending'}
            save_result(manifest,result)
            return result
        except (MigrationError,OSError) as e:
            error=e if isinstance(e,MigrationError) else MigrationError('migration_io_failed')
            error.manifest=manifest
            try:save_result(manifest,{'status':'failed','reason':str(error),'manifest':manifest,'completion':'unknown','model_calls':0})
            except OSError:pass  # Retain the original failure and recoverable manifest path.
            raise error

def rollback(manifest_path,binary,process_probe=None):
    manifest=load_manifest(manifest_path)
    probe=process_probe or processes
    ensure_quiet(probe(),binary)
    info=plan(manifest['home'],manifest['thread_id'],manifest['original_provider'])
    if digest(info['rollout'],manifest['history_size'])!=manifest['history_sha256']:raise MigrationError('history_integrity_failed')
    with operation_lock(info['home']):
        ensure_quiet(probe(),binary)
        if plan(info['home'],info['thread_id'],info['target_provider'])!=info:raise MigrationError('state_changed_before_rollback')
        try:
            save_result(manifest_path,{'status':'rollback_started','thread_id':info['thread_id'],'model_calls':0})
            cold_resume(info,binary,info['target_provider'])
            ensure_quiet(probe(),binary)
            cold_resume(info,binary)
            ensure_quiet(probe(),binary)
            result={**_verify(manifest_path,info['target_provider'],info),'status':'rolled_back','model_calls':0}
            save_result(manifest_path,result)
            return result
        except (MigrationError,OSError) as e:
            error=e if isinstance(e,MigrationError) else MigrationError('rollback_io_failed')
            error.manifest=str(manifest_path)
            try:save_result(manifest_path,{'status':'rollback_failed','reason':str(error),'completion':'unknown','model_calls':0})
            except OSError:pass
            raise error

def check_binary(binary):
    try:
        result=subprocess.run([str(binary),'--version'],capture_output=True,text=True,timeout=5)
    except (OSError,subprocess.TimeoutExpired) as failure:
        error=MigrationError('codex_version_not_verified')
        error.binary_check={'status':'version_command_timeout' if isinstance(failure,subprocess.TimeoutExpired) else 'version_command_unavailable',
            'actual_version':None,'supported_versions':list(VERIFIED_CODEX_VERSIONS)}
        raise error from None
    matched=re.fullmatch(r'codex-cli ([0-9]+\.[0-9]+\.[0-9]+)',result.stdout.strip())
    version=matched[1] if matched else None
    if result.returncode==0 and version in VERIFIED_CODEX_VERSIONS:return version
    error=MigrationError('codex_version_not_verified')
    error.binary_check={'status':'version_command_failed' if result.returncode!=0 else 'unsupported_version' if matched else 'unrecognized_version_output',
        'actual_version':version,'supported_versions':list(VERIFIED_CODEX_VERSIONS),'exit_code':result.returncode}
    raise error

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    default_binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    for action in ['plan','migrate']:
        p=sub.add_parser(action);p.add_argument('--home',required=True);p.add_argument('--thread-id',required=True)
        if action=='migrate':p.add_argument('--backup-dir',required=True)
        p.add_argument('--codex-bin',default=default_binary)
    for action in ['verify','rollback']:
        p=sub.add_parser(action);p.add_argument('--manifest',required=True)
        if action=='rollback':p.add_argument('--codex-bin',default=default_binary)
    args=parser.parse_args()
    try:
        verified_version=check_binary(args.codex_bin) if args.action in ('migrate','rollback') else None
        if args.action=='plan':
            result={'status':'planned',**plan(args.home,args.thread_id)}
            try:ensure_quiet(processes(),args.codex_bin);result['backend_quiet']=True
            except MigrationError:result['backend_quiet']=False
            result['router_health']='not_contacted_in_read_only_plan'
        elif args.action=='migrate':result=migrate(args.home,args.thread_id,args.codex_bin,args.backup_dir)
        elif args.action=='verify':result=verify(args.manifest)
        else:result=rollback(args.manifest,args.codex_bin)
        if verified_version is not None:result['codex_version']=verified_version
        print(json.dumps(result,indent=2));return 0
    except (MigrationError,OSError) as e:
        result={'status':'blocked_or_failed','reason':str(e) if isinstance(e,MigrationError) else 'filesystem_permission_or_io_failed',
            'model_calls':0,'api_fallback':False}
        if getattr(e,'manifest',None):result['manifest']=e.manifest
        if getattr(e,'binary_check',None):result['binary_check']=e.binary_check
        print(json.dumps(result,indent=2));return 1

if __name__=='__main__':raise SystemExit(main())
