"""Authenticated HTTP bridge to one bounded MARS JVM per browser session."""
from collections import OrderedDict
import atexit
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import subprocess
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
TOKEN = os.environ.get('MARS_GATEWAY_TOKEN', '')
MAX_SESSIONS = int(os.environ.get('MARS_MAX_SESSIONS', '8'))
IDLE = int(os.environ.get('MARS_IDLE_SECONDS', '600'))
TIMEOUT = float(os.environ.get('MARS_COMMAND_TIMEOUT', '20'))
SECURE = os.environ.get('MARS_SECURE_COOKIE', '1') == '1'
COOKIE = 'mars_session'
CHECK_COOKIE = 'mars_checker'
CHECK_TIMEOUT = 5
REQUEST_LIMIT = 8_000_000
sessions = {}
pool_lock = threading.RLock()


class Machine:
    def __init__(self, entry='mars.ide.Stdio'):
        self.entry = entry
        self.lock = threading.Lock()
        self.last = self.born = time.monotonic()
        self.directory = tempfile.mkdtemp(prefix='mars-session-')
        self.process = subprocess.Popen([
            os.environ.get('MARS_JAVA', 'java'), '-Xms16m', '-Xmx192m',
            '-XX:MaxMetaspaceSize=96m', '-XX:+UseSerialGC',
            '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8',
            '-Djava.io.tmpdir=' + self.directory,
            '-Djava.util.prefs.userRoot=' + self.directory,
            '-cp', str(ROOT / 'teaching/build/classes'), entry,
        ], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, bufsize=0,
            env={k: v for k, v in os.environ.items() if k != 'MARS_GATEWAY_TOKEN'})
        self.pending = b''

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        shutil.rmtree(self.directory, ignore_errors=True)

    def command(self, body):
        # Partial writes are possible for large imported source projects.
        data = memoryview(body + b'\n')
        deadline = time.monotonic() + (CHECK_TIMEOUT if self.entry == 'mars.ide.Checker' else TIMEOUT)
        fd = self.process.stdin.fileno()
        os.set_blocking(fd, False)
        while data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
                raise TimeoutError('Execution timed out')
            data = data[os.write(fd, data):]
        while b'\n' not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError('Execution timed out')
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('Execution process stopped')
            self.pending += chunk
            if len(self.pending) > 32 * 1024 * 1024:
                raise RuntimeError('Execution response exceeded memory limit')
        line, self.pending = self.pending.split(b'\n', 1)
        json.loads(line)
        return line


def unknown(request):
    return {'protocol': 1, 'id': request.get('id'), 'status': 'undetermined',
            'diagnostics': [], 'undetermined': []}


class CheckPool:
    """One checker JVM; newest queued request per browser, separate from sessions."""
    def __init__(self):
        self.condition = threading.Condition()
        self.pending = OrderedDict()
        self.io_lock = threading.Lock()
        self.machine = None
        threading.Thread(target=self.work, daemon=True).start()

    def call(self, client, request):
        task = {'request': request, 'done': threading.Event(), 'result': unknown(request)}
        with self.condition:
            old = self.pending.pop(client, None)
            if old:
                old['done'].set()
            if len(self.pending) >= 16:
                return task['result']
            self.pending[client] = task
            self.condition.notify()
        if not task['done'].wait(10):
            with self.condition:
                if self.pending.get(client) is task:
                    self.pending.pop(client)
            return unknown(request)
        return task['result']

    def close(self):
        with self.io_lock:
            if self.machine:
                self.machine.close()
                self.machine = None

    def work(self):
        while True:
            with self.condition:
                while not self.pending:
                    self.condition.wait()
                _, task = self.pending.popitem(last=False)
            request = task['request']
            with self.io_lock:
                try:
                    if self.machine is None:
                        self.machine = Machine('mars.ide.Checker')
                    result = json.loads(self.machine.command(json.dumps(request).encode()))
                    if result.get('protocol') != 1 or result.get('id') != request.get('id'):
                        raise ValueError('Checker reply mismatch')
                    task['result'] = result
                except (OSError, RuntimeError, ValueError, TimeoutError):
                    if self.machine:
                        self.machine.close()
                    self.machine = None
            task['done'].set()


checker = CheckPool()

def reap():
    with pool_lock:
        now = time.monotonic()
        for sid, machine in list(sessions.items()):
            if (now - machine.last > IDLE or now - machine.born > 7200 or
                    machine.process.poll() is not None):
                if machine.lock.acquire(blocking=False):
                    try:
                        del sessions[sid]
                        machine.close()
                    finally:
                        machine.lock.release()


def cleanup():
    checker.close()
    with pool_lock:
        for machine in list(sessions.values()):
            machine.close()
        sessions.clear()


atexit.register(cleanup)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        # Do not log requests, student source, session identifiers or credentials.
        pass

    def reply(self, code, body, mime='application/json; charset=utf-8', sid=None, check_sid=None):
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if sid:
            self.send_header('Set-Cookie', f'{COOKIE}={sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age={IDLE}' + ('; Secure' if SECURE else ''))
        if check_sid:
            self.send_header('Set-Cookie', f'{CHECK_COOKIE}={check_sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200' + ('; Secure' if SECURE else ''))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.reply(403, {'error': 'Forbidden'})
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        if self.path == '/examples':
            examples = []
            for directory in sorted((ROOT / 'teaching/examples').iterdir()):
                metadata = directory / 'example.json'
                if not directory.is_dir() or not metadata.is_file():
                    continue
                example = json.loads(metadata.read_text(encoding='utf-8'))
                example['name'] = directory.name
                languages = {}
                for language in sorted(directory.iterdir()):
                    if not language.is_dir():
                        continue
                    source, data = {}, {}
                    for path in sorted(language.iterdir()):
                        if not path.is_file() or path.name.startswith('.'):
                            continue
                        target = source if path.suffix in ('.s', '.asm') else data
                        target[path.name] = path.read_text(encoding='utf-8')
                    languages[language.name] = dict(files=source, data=data)
                example['languages'] = languages
                examples.append(example)
            examples.sort(key=lambda example: example.get('order', 0))
            return self.reply(200, json.dumps(examples).encode())
        return self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        if not self.authorized():
            return self.reply(403, {'error': 'Forbidden'})
        if self.path not in ('/api', '/api/check'):
            return self.reply(404, {'error': 'Not found'})
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if (self.headers.get('Sec-Fetch-Site') == 'cross-site' or
                (origin and origin not in ('http://' + host, 'https://' + host))):
            return self.reply(403, {'error': 'Forbidden origin'})
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            return self.reply(415, {'error': 'Expected JSON'})
        try:
            length = int(self.headers.get('Content-Length', '-1'))
            if not 0 < length <= REQUEST_LIMIT:
                return self.reply(413, {'error': 'Request limit 8 MB'})
            body = self.rfile.read(length)
            request = json.loads(body)
            if not isinstance(request, dict) or not isinstance(request.get('command'), str):
                raise ValueError('Expected command object')
            body = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode()
        except (ValueError, UnicodeError):
            return self.reply(400, {'error': 'Invalid JSON request'})
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except Exception:
            pass
        if self.path == '/api/check':
            if request.get('protocol') != 1 or request['command'] not in ('line', 'full'):
                return self.reply(400, {'error': 'Invalid checker request'})
            client = cookie[CHECK_COOKIE].value if CHECK_COOKIE in cookie else ''
            if not re.fullmatch(r'[A-Za-z0-9_-]{43}', client):
                client = secrets.token_urlsafe(32)
            return self.reply(200, checker.call(client, request), check_sid=client)
        sid = cookie[COOKIE].value if COOKIE in cookie else '' 
        reap()
        with pool_lock:
            machine = sessions.get(sid)
            if machine is None:
                # A stale session must never silently execute a different program.
                if request['command'] != 'assemble':
                    return self.reply(409, {'error': '会话已过期，请点击“汇编”重新开始。'})
                if len(sessions) >= MAX_SESSIONS:
                    return self.reply(503, {'error': '课堂执行席位已满，请稍后重试。空闲会话会自动释放。'})
                sid = secrets.token_urlsafe(32)
                try:
                    machine = Machine()
                except OSError:
                    return self.reply(503, {'error': '执行服务暂时不可用。'})
                sessions[sid] = machine
            if not machine.lock.acquire(blocking=False):
                return self.reply(409, {'error': '该会话正在执行，请稍后重试。'})
        try:
            machine.last = time.monotonic()
            result = machine.command(body)
            machine.last = time.monotonic()
            self.reply(200, result, sid=sid)
        except (OSError, RuntimeError, ValueError, TimeoutError):
            with pool_lock:
                sessions.pop(sid, None)
            machine.close()
            self.reply(503, {'error': '执行超时或达到资源限制，请重新汇编。'})
        finally:
            machine.lock.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32


if __name__ == '__main__':
    if len(TOKEN) < 32:
        raise SystemExit('Set MARS_GATEWAY_TOKEN to a strong service credential')
    def janitor():
        while True:
            time.sleep(15)
            reap()
    threading.Thread(target=janitor, daemon=True).start()
    Server((os.environ.get('MARS_BIND', '127.0.0.1'), int(os.environ.get('MARS_PORT', '8767'))), Handler).serve_forever()
