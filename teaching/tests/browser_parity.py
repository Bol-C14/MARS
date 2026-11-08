"""Compare JVM and TeaVM machine state after each original example instruction."""
import json, pathlib, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
def start(args):
    return subprocess.Popen(args,cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
jvm=start(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Stdio'])
js=start(['node','teaching/tests/browser_stdio.cjs'])
count=0
serial=0
def call(command, **fields):
    global serial
    serial+=1
    body=dict(command=command,**fields)
    jvm.stdin.write(json.dumps(body)+'\n');jvm.stdin.flush()
    js.stdin.write(json.dumps(dict(id=serial,body=body))+'\n');js.stdin.flush()
    a=json.loads(jvm.stdout.readline());envelope=json.loads(js.stdout.readline())
    assert 'error' not in envelope,envelope
    b=envelope['result']
    for key in ['status','error','pc','registers','memory','output','inputEchoes','generatedFiles','heap','step','historyLength','diagnostics']:
        assert a.get(key)==b.get(key),(command,key,a.get(key),b.get(key))
    return a
try:
    for directory in sorted((ROOT/'teaching/examples').iterdir()):
        if not directory.is_dir():continue
        files={p.name:p.read_text() for p in (directory/'en').glob('*.s')}
        inputs={'02-calculator':['17','5']}.get(directory.name,['898'])
        for delay in [False,True]:
            state=call('assemble',files=files,entry='main.s',data={'input.txt':'85\n92\n'},inputs=inputs,delay=delay)
            while True:
                call('memory',address=0x10010000,length=128)
                call('memory',address=0x7fffefe0,length=32)
                count+=1
                if state['status'] in ['ended','error','waiting']:break
                state=call('step')
            assert state['status']=='ended',(directory.name,state.get('error'))
    print(f'PASS: {count} JVM/browser snapshots (PC, registers, data, stack, output, generated files), every example × delay on/off')
finally:
    for p in [jvm,js]:p.terminate();p.wait()
