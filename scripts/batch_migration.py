#!/usr/bin/env python3
"""Move many existing Codex chats to the GPT + Claude router at once. Python 3.9+, no model calls.

One database snapshot and one config copy back up the whole batch. The manifest lists every thread and its original
provider, so rollback restores exactly those rows. Only threads.model_provider changes, in one transaction.
Codex and the desktop app must be fully quit.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import thread_migration as tm  # noqa: E402

SOURCE, TARGET = 'openai', 'codex_model_router'
Error = tm.MigrationError
CHUNK = 500


def _read(database):
    """Read-only while Codex runs (its -shm exists). After Codex quits, SQLite cannot open the WAL database read-only
    without creating -shm, so fall back to a normal connection limited to queries."""
    con = None
    try:
        con = tm.readonly_db(database)
        con.execute('SELECT 1 FROM threads LIMIT 1').fetchall()
        return con
    except sqlite3.OperationalError:
        if con is not None:
            con.close()
        con = sqlite3.connect(str(database), timeout=10)
        con.execute('PRAGMA query_only = ON')
        return con


def _database(home):
    dbs = sorted(home.glob('state_*.sqlite'), key=lambda p: int(p.stem.split('_')[-1]))
    if not dbs:
        raise Error('state_database_missing')
    if dbs[-1].is_symlink():
        raise Error('database_symlink_refused')
    return dbs[-1]


def _chunks(ids):
    for k in range(0, len(ids), CHUNK):
        yield ids[k:k + CHUNK]


def _fingerprint(db):
    """Hash of every thread row with the provider column blanked: proves nothing else changed."""
    cols = [r[1] for r in db.execute('PRAGMA table_info(threads)')]
    i = cols.index('model_provider')
    h = hashlib.sha256()
    for row in db.execute('SELECT * FROM threads ORDER BY id'):
        row = list(row)
        row[i] = None
        h.update(repr(row).encode())
        h.update(b'\n')
    return h.hexdigest()


def _rows(db, ids):
    out = {}
    for chunk in _chunks(ids):
        q = 'SELECT id, model_provider, rollout_path, cwd FROM threads WHERE id IN (%s)' % ','.join('?' * len(chunk))
        for r in db.execute(q, chunk):
            out[r[0]] = {'provider': r[1], 'rollout': r[2], 'cwd': r[3]}
    return out


def plan(home, include_subagents=False, include_archived=False):
    home = Path(home).resolve()
    config = home / 'config.toml'
    try:
        if not re.search(r'^\[model_providers\.codex_model_router\]\s*$', config.read_text(), re.M):
            raise Error('router_not_configured')
        database = _database(home)
        with closing(_read(database)) as db:
            where, args = ['model_provider = ?'], [SOURCE]
            if not include_archived:
                where.append('archived = 0')
            if not include_subagents:
                where.append("COALESCE(source, '') NOT LIKE '{%subagent%'")
            ids = [r[0] for r in db.execute('SELECT id FROM threads WHERE %s ORDER BY id' % ' AND '.join(where), args)]
            counts = dict(db.execute('SELECT model_provider, COUNT(*) FROM threads GROUP BY model_provider').fetchall())
            fingerprint = _fingerprint(db)
    except (OSError, sqlite3.Error, ValueError) as e:
        raise Error('plan_read_failed:%s:%s' % (type(e).__name__, str(e)[:80])) from None
    return {'home': str(home), 'database': str(database), 'config': str(config), 'config_sha256': tm.digest(config),
            'threads': ids, 'count': len(ids), 'providers_before': counts, 'fingerprint': fingerprint,
            'include_subagents': include_subagents, 'include_archived': include_archived}


def _set(database, ids, frm, to, expect=None):
    con = sqlite3.connect(str(database), timeout=10)
    try:
        with con:  # one transaction; an exception inside rolls it back
            changed = 0
            for chunk in _chunks(ids):
                q = 'UPDATE threads SET model_provider = ? WHERE model_provider = ? AND id IN (%s)' % ','.join('?' * len(chunk))
                changed += con.execute(q, [to, frm, *chunk]).rowcount
            if expect is not None and changed != expect:
                raise Error('row_count_mismatch:%d/%d' % (changed, expect))
            return changed
    except sqlite3.Error as e:
        raise Error('database_update_failed:' + type(e).__name__) from None
    finally:
        con.close()


def _check(info, expected):
    with closing(_read(info['database'])) as db:
        rows = _rows(db, info['threads'])
        wrong = [i for i in info['threads'] if rows.get(i, {}).get('provider') != expected]
        if wrong:
            raise Error('provider_not_persisted:%d' % len(wrong))
        if _fingerprint(db) != info['fingerprint']:
            raise Error('other_columns_changed')
    if tm.digest(info['config']) != info['config_sha256']:
        raise Error('configuration_changed')
    return rows


def _sample(info, rows, binary, size, check):
    """Cold-resume a few migrated threads natively and confirm Codex reads the router provider.
    Only open, user-started threads are sampled: Codex rejects resuming archived threads, and sub-agent
    sessions are not resumed directly by users."""
    with closing(_read(info['database'])) as db:
        eligible = set()
        for chunk in _chunks(info['threads']):
            q = ("SELECT id FROM threads WHERE archived = 0 AND COALESCE(source, '') NOT LIKE '{%%subagent%%' "
                 "AND id IN (%s)" % ','.join('?' * len(chunk)))
            eligible.update(r[0] for r in db.execute(q, chunk))
    def length(i):
        try:
            return os.path.getsize(rows[i]['rollout'])
        except (OSError, TypeError):
            return float('inf')
    picked = [i for i in check if i in rows and i in eligible]
    picked += [i for i in sorted(eligible, key=lambda i: (length(i), i)) if i not in picked][:max(0, size)]
    for i in picked:
        try:
            tm.cold_resume({'home': info['home'], 'cwd': rows[i]['cwd'] or info['home'], 'thread_id': i,
                            'target_provider': TARGET}, binary)
        except Error as e:
            raise Error('sample_resume_failed:%s:%s' % (i, e)) from None
    return picked


def _save(folder, result):
    out = folder / 'operation-result.json'
    tmp = out.with_suffix('.tmp')
    tmp.write_text(json.dumps(result, indent=2))
    tmp.chmod(0o600)
    os.replace(str(tmp), str(out))


def migrate(home, binary, backup_dir, include_subagents=False, include_archived=False, sample=3, check=(),
            probe=None, health=None):
    probe = probe or tm.processes
    tm.ensure_quiet(probe(), binary)
    info = plan(home, include_subagents, include_archived)
    if not info['threads']:
        return {'status': 'nothing_to_migrate', 'model_calls': 0, 'providers': info['providers_before']}
    if not (health or tm.router_health)(info):
        raise Error('router_health_not_verified')
    with tm.operation_lock(info['home']):
        tm.ensure_quiet(probe(), binary)
        if plan(home, include_subagents, include_archived) != info:
            raise Error('state_changed_before_backup')
        folder = Path(backup_dir) / ('batch-' + uuid.uuid4().hex)
        try:
            folder.mkdir(parents=True, mode=0o700)
            snapshot = folder / 'state.sqlite'
            with closing(_read(info['database'])) as src, closing(sqlite3.connect(str(snapshot))) as dst:
                src.backup(dst)
            snapshot.chmod(0o600)
            shutil.copyfile(info['config'], str(folder / 'config.toml'))
            (folder / 'config.toml').chmod(0o600)
            manifest = {**info, 'original_provider': SOURCE, 'target_provider': TARGET,
                        'backups': {n: tm.digest(folder / n) for n in ('state.sqlite', 'config.toml')}}
            path = folder / 'manifest.json'
            path.write_text(json.dumps(manifest, indent=2))
            path.chmod(0o600)
        except (OSError, sqlite3.Error):
            raise Error('backup_failed') from None
        try:
            tm.ensure_quiet(probe(), binary)
            _save(folder, {'status': 'started', 'count': info['count'], 'model_calls': 0})
            _set(info['database'], info['threads'], SOURCE, TARGET, expect=info['count'])
            rows = _check(info, TARGET)
            sampled = _sample(info, rows, binary, sample, check)
            tm.ensure_quiet(probe(), binary)
        except (Error, OSError) as e:
            reason = str(e) if isinstance(e, Error) else 'migration_io_failed'
            try:
                reverted = _set(info['database'], info['threads'], TARGET, SOURCE)
            except Error as again:
                reverted = 'failed:' + str(again)
            _save(folder, {'status': 'failed_and_reverted', 'reason': reason, 'reverted': reverted, 'model_calls': 0})
            error = Error(reason)
            error.manifest = str(path)
            raise error
        result = {'status': 'migrated', 'count': info['count'], 'sampled_cold_resume': sampled,
                  'other_columns_preserved': True, 'configuration_preserved': True, 'model_calls': 0,
                  'manifest': str(path)}
        _save(folder, result)
        return result


def rollback(manifest_path, binary, probe=None):
    path = Path(manifest_path).resolve()
    try:
        manifest = json.loads(path.read_text())
        for n in ('state.sqlite', 'config.toml'):
            if tm.digest(path.parent / n) != manifest['backups'][n]:
                raise Error('backup_integrity_failed')
    except (OSError, ValueError, KeyError):
        raise Error('manifest_invalid') from None
    probe = probe or tm.processes
    tm.ensure_quiet(probe(), binary)
    with tm.operation_lock(manifest['home']):
        tm.ensure_quiet(probe(), binary)
        reverted = _set(manifest['database'], manifest['threads'], manifest['target_provider'], manifest['original_provider'])
        with closing(_read(manifest['database'])) as db:
            rows = _rows(db, manifest['threads'])
        left = [i for i in manifest['threads'] if rows.get(i, {}).get('provider') != manifest['original_provider']]
        result = {'status': 'rolled_back' if not left else 'partially_rolled_back', 'reverted': reverted,
                  'not_original': len(left), 'model_calls': 0}
        _save(path.parent, result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    default_binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    for action in ('plan', 'migrate'):
        p = sub.add_parser(action)
        p.add_argument('--home', required=True)
        p.add_argument('--include-subagents', action='store_true')
        p.add_argument('--include-archived', action='store_true')
        p.add_argument('--codex-bin', default=default_binary)
        if action == 'migrate':
            p.add_argument('--backup-dir', required=True)
            p.add_argument('--sample', type=int, default=3)
            p.add_argument('--check', action='append', default=[], help='also cold-resume this thread id')
    p = sub.add_parser('rollback')
    p.add_argument('--manifest', required=True)
    p.add_argument('--codex-bin', default=default_binary)
    args = parser.parse_args()
    try:
        version = tm.check_binary(args.codex_bin) if args.action in ('migrate', 'rollback') else None
        if args.action == 'plan':
            info = plan(args.home, args.include_subagents, args.include_archived)
            result = {'status': 'planned', 'count': info['count'], 'providers_before': info['providers_before'],
                      'first_threads': info['threads'][:5], 'database': info['database']}
            try:
                tm.ensure_quiet(tm.processes(), args.codex_bin)
                result['backend_quiet'] = True
            except Error:
                result['backend_quiet'] = False
        elif args.action == 'migrate':
            result = migrate(args.home, args.codex_bin, args.backup_dir, args.include_subagents, args.include_archived,
                             args.sample, args.check)
        else:
            result = rollback(args.manifest, args.codex_bin)
        if version is not None:
            result['codex_version'] = version
        print(json.dumps(result, indent=2))
        return 0
    except (Error, OSError) as e:
        result = {'status': 'blocked_or_failed', 'reason': str(e) if isinstance(e, Error) else 'filesystem_permission_or_io_failed',
                  'model_calls': 0}
        if getattr(e, 'manifest', None):
            result['manifest'] = e.manifest
        print(json.dumps(result, indent=2))
        return 1


if __name__ == '__main__':
    sys.exit(main())
