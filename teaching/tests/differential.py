"""Compare observable results against the pinned, unmodified upstream CLI."""
import json,pathlib,subprocess,tempfile,time,statistics
ROOT=pathlib.Path(__file__).resolve().parents[2]
UPSTREAM=ROOT/'teaching/build/upstream'
p=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Stdio'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def call(command,**kw):
 p.stdin.write(json.dumps(dict(command=command,**kw))+'\n');p.stdin.flush();s=json.loads(p.stdout.readline());assert 'protocol' in s,s;return s
def finish():
 for _ in range(150):
  s=call('run',limit=1000)
  if s['status']!='paused':return s
  assert s['stopReason']=='Batch complete',s['stopReason']
 raise AssertionError('step budget')
results=[]
for delay in [False,True]:
 for name,data,stdin in [('hexout',{},'898\n'),('hexout',{},'-1\n'),('array-sum',{},''),*[('task1',{} if c is None else {'input.txt':c},'') for c in ['Hi','',None,'A\0B','x'*4095,'x'*4096]]]:
  files={f.name:f.read_text() for f in (ROOT/'teaching/examples'/name).glob('*.s')}
  call('assemble',files=files,data=data,inputs=stdin.splitlines(),entry='main.s',delay=delay);s=finish()
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp)
   for n,c in {**files,**data}.items():(root/n).write_text(c)
   args=['java','-Djava.awt.headless=true','-cp',str(UPSTREAM),'Mars','sm','nc']+(['db'] if delay else [])+['main.s']+sorted(n for n in files if n!='main.s')
   original=subprocess.run(args,cwd=root,input=stdin,text=True,capture_output=True,timeout=20)
   expected=original.stdout[:-1] if original.stdout.endswith('\n') else original.stdout
   assert s['output']==expected,(name,delay,len(data.get('input.txt','')),s['output'][:100],original.stdout[:100],original.stderr)
   assert s['exitCode']%256==original.returncode,(s['exitCode'],original.returncode)
   results.append(dict(example=name,delay=delay,bytes=len(data.get('input.txt','')),steps=s['step'],outputBytes=len(s['output']),exit=s['exitCode']))
# Repeated exact previews cannot modify state or I/O.
files={'main.s':'.text\nmain:\nli $t0,1\naddiu $t0,$t0,1\nli $v0,10\nsyscall\n'}
call('assemble',files=files,entry='main.s');call('step');times=[]
for _ in range(40):
 t=time.perf_counter();s=call('state');times.append((time.perf_counter()-t)*1000);assert s['step']==1 and s['registers'][8]['value']==1
p.terminate();p.wait()
report={'upstream':'ac3d34ea65c3b8349c4f6c00306bade9e3fec5c9','cases':results,'stateAndPreviewMs':{'median':statistics.median(times),'p95':sorted(times)[37]},'transport':'local JSON-lines; Java 25; macOS arm64; not browser paint latency'}
(ROOT/'teaching/test-results').mkdir(exist_ok=True)
(ROOT/'teaching/test-results/differential.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
