import pathlib,subprocess,tempfile,json,base64
ROOT=pathlib.Path(__file__).resolve().parents[2]
UPSTREAM=ROOT/'teaching/build/upstream';PROBE=ROOT/'teaching/build/probe';PROBE.mkdir(exist_ok=True)
subprocess.run(['javac','--release','17','-cp',str(UPSTREAM),'-d',str(PROBE),str(ROOT/'teaching/tests/UpstreamProbe.java')],check=True)
p=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Stdio'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def call(command,**kw):
 p.stdin.write(json.dumps(dict(command=command,**kw))+'\n');p.stdin.flush();s=json.loads(p.stdout.readline());assert 'protocol' in s,s;return s
count=0
for name in ['hexout','task1','array-sum']:
 files={f.name:f.read_text() for f in (ROOT/'teaching/examples'/name).glob('*.s')}
 for delay in [False,True]:
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp)
   for n,c in {**files,'input.txt':'Hi'}.items():(root/n).write_text(c)
   order=['main.s']+sorted(n for n in files if n!='main.s')
   result=subprocess.run(['java','-Djava.awt.headless=true','-cp',str(PROBE)+':'+str(UPSTREAM),'UpstreamProbe',str(delay).lower(),*order],cwd=root,text=True,capture_output=True,check=True,timeout=20)
   expected=[json.loads(l) for l in result.stdout.splitlines()]
   s=call('assemble',files={n:files[n] for n in order},data={'input.txt':'Hi'},entry='main.s',delay=delay,inputs=['898'])
   for e in expected:
    if e['step']:s=call('step')
    assert s['pc']==e['pc'],(name,delay,e['step'],'PC',s['pc'],e['pc'])
    assert [r['value'] for r in s['registers'][:32]]==e['registers'],(name,delay,e['step'],'registers')
    data=call('memory',address=0x10010000)['memory'];stack=call('memory',address=0x7fffefe0)['memory']
    assert [b['value'] for b in data]+[b['value'] for b in stack[:32]]==e['memory'],(name,delay,e['step'],'memory')
    assert s['output']==base64.b64decode(e['output64']).decode(),(name,delay,e['step'],'output')
    count+=1
p.terminate();p.wait();print(f'PASS: {count} per-step snapshots (PC, 32 GPRs, data, stack, output), three programs × delay on/off')
