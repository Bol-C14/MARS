"""Worker isolation, cooperative pause, virtual I/O and browser timings."""
import hashlib,json,pathlib,sys
from browser_acceptance import launch
from playwright.sync_api import sync_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8877'
checks=[]
def check(name, ok):
    assert ok,name
    checks.append(name)
with sync_playwright() as p:
    browser=launch(p)
    try:
        page=browser.new_page()
        requests=[];page.on('request',lambda r: requests.append((r.method,r.url)))
        page.goto(URL)
        page.evaluate('''() => {
          window.workers={};window.jobs={};let seq=0;
          window.makeKernel=name=>new Promise((resolve,reject)=>{
            const start=performance.now(),w=workers[name]=new Worker('./kernel-worker.js');
            w.onerror=e=>reject(Error(e.message));
            w.onmessage=({data})=>{if(data.ready){resolve(performance.now()-start);return;}
              const job=jobs[data.id];delete jobs[data.id];data.error?job.reject(Error(data.error)):job.resolve(data.result);
            };
          });
          window.callKernel=(name,body,check=false)=>new Promise((resolve,reject)=>{const id=++seq;jobs[id]={resolve,reject};workers[name].postMessage({id,body,check});});
        }''')
        cold=page.evaluate('()=>makeKernel("debug")')
        def call(body,name='debug',lint=False):return page.evaluate('([name,body,check])=>callKernel(name,body,check)',[name,body,lint])
        source='.text\nmain:\nli $t0,7\nli $t1,3\nadd $s0,$t0,$t1\nli $v0,10\nsyscall\n'
        state=call(dict(command='assemble',files={'main.s':source},entry='main.s'))
        check('browser assembles Java MARS',state['status']=='paused')
        state=call(dict(command='step'));before=call(dict(command='state'))
        checker_ms=page.evaluate('()=>makeKernel("checker")')
        line=call(dict(command='line',file='main.s',text='addd $t0,$t1,$t2',lines=[1]),'checker',True)
        check('first line check has initialized instructions',line['status']=='ok' and bool(line['diagnostics']))
        for src in ['.text\nmain:\nb nowhere\n',source,'.macro x\nnop\n.end_macro\n.text\nmain:\nx\n']:
            reply=call(dict(command='full',files={'main.s':src},entry='main.s'),'checker',True)
            check('isolated full check responds',reply['status']=='ok')
        after=call(dict(command='state'))
        check('checker preserves paused PC/registers/history/output',all(before[k]==after[k] for k in ['pc','registers','step','historyLength','output','programVersion']))
        page.evaluate('()=>makeKernel("second")')
        call(dict(command='assemble',files={'other.s':'.text\nmain:\nli $t0,99\n'},entry='other.s'),'second')
        check('two browser runtimes keep independent machines',call(dict(command='state'))['registers'][8]['value']==7)
        # Existing project example exercises multi-source assembly, read and generated text.
        examples=page.evaluate('()=>fetch("./examples.json").then(r=>r.json())')
        project=next(e for e in examples if e['name']=='05-grades')['languages']['en']
        call(dict(command='assemble',entry='main.s',**project))
        while True:
            result=call(dict(command='run',limit=1000,skipBreakpoint=True))
            if result['status']!='paused':break
        check('input.txt is read from the project',result['status']=='ended' and bool(result['generatedFiles']))
        import base64
        for name,content in result['generatedFiles'].items():
            raw=base64.b64decode(content['base64'])
            check('output bytes retain JVM SHA-256 identity',hashlib.sha256(raw).hexdigest()==content['hash'])
        # Infinite child call: step-over must keep its stack while yielding for pause.
        loop='.text\nmain:\njal spin\nli $v0,10\nsyscall\nspin:\naddiu $t0,$t0,1\nj spin\n'
        call(dict(command='assemble',files={'main.s':loop},entry='main.s'))
        timing=page.evaluate('''async ()=>{
          const start=performance.now();const job=callKernel('debug',{command:'over',limit:100000,skipBreakpoint:true});
          setTimeout(()=>workers.debug.postMessage({pause:true}),60);
          const s=await job;return {elapsed:performance.now()-start,status:s.status,reason:s.stopReason,step:s.step};
        }''')
        check('step-over yields and pauses inside an infinite child',timing['reason']=='Paused' and 0<timing['step']<100000 and timing['elapsed']<2000)
        timing_out=page.evaluate('''async ()=>{
          const start=performance.now();const job=callKernel('debug',{command:'out',limit:100000,skipBreakpoint:true});
          setTimeout(()=>workers.debug.postMessage({pause:true}),60);
          const s=await job;return {elapsed:performance.now()-start,reason:s.stopReason};
        }''')
        check('step-out remains interruptible',timing_out['reason']=='Paused' and timing_out['elapsed']<2000)
        call(dict(command='assemble',files={'main.s':source},entry='main.s'))
        t=page.evaluate('''async()=>{let start=performance.now();await callKernel('debug',{command:'run',limit:1000});return performance.now()-start;}''')
        check('programs resume normally after cancelled commands',call(dict(command='state'))['status']=='ended')
        check('execution and checking send no API requests',not any('/api' in url for _,url in requests))
        # A new page context is a new origin storage and Worker set, never a server session.
        page.evaluate('()=>Object.values(workers).forEach(w=>w.terminate())')
        print(json.dumps(dict(passed=len(checks),checks=checks,timings_ms=dict(cold_worker=round(cold),checker_worker=round(checker_ms),pause_over=round(timing['elapsed']),pause_out=round(timing_out['elapsed']),warm_small_run=round(t))),ensure_ascii=False,indent=2))
    finally:browser.close()
