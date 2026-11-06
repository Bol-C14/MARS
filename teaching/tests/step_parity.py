import os,pathlib,subprocess,tempfile,json,base64
ROOT=pathlib.Path(__file__).resolve().parents[2]
UPSTREAM=ROOT/'teaching/build/upstream';PROBE=ROOT/'teaching/build/probe';PROBE.mkdir(exist_ok=True)
subprocess.run(['javac','--release','17','-cp',str(UPSTREAM),'-d',str(PROBE),str(ROOT/'teaching/tests/UpstreamProbe.java')],check=True)
p=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Stdio'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def call(command,**kw):
 p.stdin.write(json.dumps(dict(command=command,**kw))+'\n');p.stdin.flush();s=json.loads(p.stdout.readline());assert 'protocol' in s,s;return s
count=0
# Every example, in its English copy (the copies differ only in comments).
for name in sorted(d.name for d in (ROOT/'teaching/examples').iterdir() if d.is_dir()):
 files={f.name:f.read_text() for f in (ROOT/'teaching/examples'/name/'en').glob('*.s')}
 inputs={'02-calculator':['17','5']}.get(name,['898'])
 for delay in [False,True]:
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp)
   for n,c in {**files,'input.txt':'85\n92\n'}.items():(root/n).write_text(c)
   order=['main.s']+sorted(n for n in files if n!='main.s')
   result=subprocess.run(['java','-Djava.awt.headless=true','-cp',str(PROBE)+':'+str(UPSTREAM),'UpstreamProbe',str(delay).lower(),*order],cwd=root,text=True,capture_output=True,check=True,timeout=60,env={**os.environ,'PROBE_STDIN':''.join(i+'\n' for i in inputs)})
   expected=[json.loads(l) for l in result.stdout.splitlines()]
   s=call('assemble',files={n:files[n] for n in order},data={'input.txt':'85\n92\n'},entry='main.s',delay=delay,inputs=inputs)
   for e in expected:
    if e['step']:s=call('step')
    assert s['pc']==e['pc'],(name,delay,e['step'],'PC',s['pc'],e['pc'])
    assert [r['value'] for r in s['registers'][:32]]==e['registers'],(name,delay,e['step'],'registers')
    data=call('memory',address=0x10010000,length=128)['memory'];stack=call('memory',address=0x7fffefe0,length=32)['memory']
    assert [b['value'] for b in data]+[b['value'] for b in stack[:32]]==e['memory'],(name,delay,e['step'],'memory')
    assert s['output']==base64.b64decode(e['output64']).decode(),(name,delay,e['step'],'output')
    count+=1
p.terminate();p.wait();print(f'PASS: {count} per-step snapshots (PC, 32 GPRs, data, stack, output), every example × delay on/off')
