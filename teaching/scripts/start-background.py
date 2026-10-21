"""Start the local IDE independently of the launching terminal or agent session."""
import pathlib
import subprocess
import sys
import time
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
url = f'http://127.0.0.1:{port}'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def ready():
    try:
        with opener.open(url, timeout=0.5) as response:
            return b'MARS' in response.read(4096)
    except OSError:
        return False

if ready():
    print(f'MARS Trace is already running: {url}')
    raise SystemExit(0)

log_path = root / 'teaching/build/server.log'
with log_path.open('ab') as log:
    process = subprocess.Popen(
        ['java', '-Djava.awt.headless=true', '-cp',
         str(root / 'teaching/build/classes'), 'mars.ide.Server', str(port)],
        cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
        start_new_session=True,
    )
for _ in range(30):
    if ready():
        (root / 'teaching/build/server.pid').write_text(str(process.pid))
        print(f'MARS Trace is running: {url} (PID {process.pid})')
        raise SystemExit(0)
    if process.poll() is not None:
        break
    time.sleep(0.1)
raise SystemExit(f'Could not start MARS Trace. See {log_path}')
