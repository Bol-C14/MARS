"""Exercise real isolated JVMs, bounded capacity, expiry and failures."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest
import urllib.error
import urllib.request

os.environ['MARS_GATEWAY_TOKEN'] = 'test-only-credential-not-used-in-production'
os.environ['MARS_SECURE_COOKIE'] = '0'
spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('gateway.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = g.Server(('127.0.0.1', 0), g.Handler)
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        g.cleanup()

    def tearDown(self):
        g.cleanup()

    def call(self, command=None, cookie='', auth=True, path='/api', **kw):
        body = None if command is None else json.dumps(dict(command=command, **kw)).encode()
        headers = {'Content-Type': 'application/json', 'Cookie': cookie}
        if auth:
            headers['Authorization'] = 'Bearer ' + g.TOKEN
        request = urllib.request.Request(self.base + path, data=body, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers.get('Set-Cookie', '').split(';')[0]

    def assemble(self, number):
        code = f'.text\nmain:\nli $t0,{number}\nli $a0,{number}\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n'
        status, data, cookie = self.call('assemble', files={'main.s': code}, entry='main.s')
        self.assertEqual(status, 200, data)
        self.assertEqual(data['status'], 'paused', data)
        self.assertTrue(cookie)
        return cookie

    def test_eight_parallel_students_and_capacity(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            cookies = list(executor.map(self.assemble, range(11, 19)))
        self.assertEqual(len(set(cookies)), 8)
        status, _, _ = self.call('assemble', files={'main.s': '.text\nmain: nop'}, entry='main.s')
        self.assertEqual(status, 503)
        def finish(pair):
            i, cookie = pair
            status, data, _ = self.call('run', cookie=cookie, limit=100)
            self.assertEqual(status, 200, data)
            self.assertEqual(data['output'], str(i))
            self.assertEqual(data['registers'][8]['value'], i)
            self.assertEqual(data['status'], 'ended')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(finish, zip(range(11, 19), cookies)))
        self.call('seek', cookie=cookies[0], step=0)
        _, other, _ = self.call('state', cookie=cookies[1])
        self.assertEqual(other['output'], '12')
        self.assertEqual(other['status'], 'ended')

    def test_auth_and_examples(self):
        self.assertEqual(self.call(path='/health', auth=False)[0], 403)
        self.assertEqual(self.call(path='/health')[0], 200)
        status, examples, _ = self.call(path='/examples')
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(examples), 3)
        self.assertEqual(len(examples), 5)
        grades = next(e for e in examples if e['name'] == '05-grades')
        self.assertEqual(grades['entry'], 'main.s')
        self.assertEqual(set(grades['languages']), {'zh-CN', 'en'})
        for language in grades['languages'].values():
            self.assertIn('main.s', language['files'])
            self.assertIn('input.txt', language['data'])
        self.assertFalse(g.sessions)

    def test_authenticated_cross_origin_requests_are_rejected(self):
        body = json.dumps(dict(command='assemble',files={'main.s':'.text\nmain: nop'},entry='main.s')).encode()
        req=urllib.request.Request(self.base+'/api',data=body,headers={'Content-Type':'application/json','Authorization':'Bearer '+g.TOKEN,'Origin':'https://other.example'})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(req,timeout=5)
        self.assertEqual(error.exception.code,403)
        self.assertFalse(g.sessions)

    def test_expiry_kills_only_expired_process_and_removes_files(self):
        a, b = self.assemble(1), self.assemble(2)
        m = g.sessions[a.split('=')[1]]
        m.last = time.monotonic() - g.IDLE - 1
        g.reap()
        self.assertIsNotNone(m.process.poll())
        self.assertFalse(Path(m.directory).exists())
        self.assertEqual(self.call('state', cookie=a)[0], 409)
        self.assertEqual(self.call('state', cookie=b)[0], 200)

    def test_busy_and_dead_worker(self):
        cookie = self.assemble(1)
        machine = g.sessions[cookie.split('=')[1]]
        machine.lock.acquire()
        try:
            self.assertEqual(self.call('step', cookie=cookie)[0], 409)
        finally:
            machine.lock.release()
        machine.process.kill()
        machine.process.wait()
        self.assertEqual(self.call('step', cookie=cookie)[0], 409)
        self.assertFalse(Path(machine.directory).exists())

    def test_timeout_removes_worker(self):
        cookie = self.assemble(1)
        machine = g.sessions[cookie.split('=')[1]]
        import signal
        os.kill(machine.process.pid, signal.SIGSTOP)
        old = g.TIMEOUT
        g.TIMEOUT = .1
        try:
            self.assertEqual(self.call('step', cookie=cookie)[0], 503)
        finally:
            g.TIMEOUT = old
        self.assertFalse(g.sessions)
        self.assertIsNotNone(machine.process.poll())
        self.assertFalse(Path(machine.directory).exists())

    def test_checker_is_separate_and_preserves_debug_state(self):
        cookie = self.assemble(31)
        self.call('step', cookie=cookie)
        _, before, _ = self.call('state', cookie=cookie)
        _, full, checker_cookie = self.call('full', path='/api/check', protocol=1, id=1,
            files={'other.s': '.text\nmain: j missing\n'}, entry='other.s')
        self.assertEqual(full['status'], 'ok')
        self.assertTrue(full['diagnostics'])
        self.assertTrue(checker_cookie.startswith('mars_checker='))
        _, line, _ = self.call('line', path='/api/check', protocol=1, id=2,
            file='x.s', text='.text\naddd $t0,$t1,$t2\n', lines=[2])
        self.assertTrue(line['diagnostics'])
        _, after, _ = self.call('state', cookie=cookie)
        for key in ('pc', 'step', 'registers', 'memory', 'output', 'historyLength', 'status'):
            self.assertEqual(before[key], after[key], key)
        self.assertNotEqual(g.checker.machine.process.pid, g.sessions[cookie.split('=')[1]].process.pid)

    def test_checker_timeout_and_crash_never_remove_students(self):
        import signal
        cookie = self.assemble(9)
        request = dict(path='/api/check', protocol=1, file='x.s', text='.text\nnop', lines=[2])
        self.call('line', id=1, **request)
        process = g.checker.machine.process
        os.kill(process.pid, signal.SIGSTOP)
        old = g.CHECK_TIMEOUT
        g.CHECK_TIMEOUT = .1
        try:
            _, result, _ = self.call('line', id=2, **request)
            self.assertEqual(result['status'], 'undetermined')
        finally:
            g.CHECK_TIMEOUT = old
        self.assertIsNotNone(process.poll())
        self.assertEqual(self.call('state', cookie=cookie)[0], 200)
        self.assertEqual(self.call('line', id=3, **request)[1]['status'], 'ok')
        g.checker.machine.process.kill()
        g.checker.machine.process.wait()
        self.assertEqual(self.call('line', id=4, **request)[1]['status'], 'undetermined')
        self.assertEqual(self.call('line', id=5, **request)[1]['status'], 'ok')
        self.assertEqual(self.call('state', cookie=cookie)[0], 200)

    def test_checker_parallel_students_do_not_share_symbols(self):
        def check(i):
            name = 'only_' + str(i)
            src = '.text\nmain: j ' + name + '\n' + name + ': nop\n'
            status, result, _ = self.call('full', path='/api/check', protocol=1, id=i,
                files={'main.s':src}, entry='main.s')
            self.assertEqual(status, 200)
            self.assertEqual(result['id'], i)
            self.assertEqual(result['diagnostics'], [])
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(check, range(8)))
        self.assertFalse(g.sessions)
        result = self.call('full', path='/api/check', protocol=1, id=10,
            files={'main.s':'.text\nmain: j only_1\n'}, entry='main.s')[1]
        self.assertTrue(result['diagnostics'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
