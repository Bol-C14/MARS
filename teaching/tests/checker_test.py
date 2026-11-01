"""The checker process: answers, reset between programs, debug isolation, failure."""
import json, os, pathlib, socket, subprocess, time, unittest, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
JAVA=['java','-Djava.awt.headless=true','-cp','teaching/build/classes']
def checker():
    return subprocess.Popen(JAVA+['mars.ide.Checker'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
def ask(p,**request):
    p.stdin.write(json.dumps(request)+'\n');p.stdin.flush();return json.loads(p.stdout.readline())
def full(p,files,entry='main.s',**kw):
    return ask(p,id=1,command='full',files=files,entry=entry,**kw)
def lines(p,text):
    n=len(text.split('\n'));return ask(p,id=2,command='line',file='main.s',text=text,lines=list(range(1,n+1)))
class Answers(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.p=checker()
    @classmethod
    def tearDownClass(cls): cls.p.stdin.close();cls.p.wait(timeout=5)
    def found(self,text): return {d['line']:d['message'] for d in lines(self.p,text)['diagnostics']}
    def test_lines_report_what_one_line_can_show(self):
        r=self.found('.text\nmain: addd $t0,$t0,$t0\n add $t0,$t1\n add $t0,$t9x,1\n add $t0,$t1,$t2  # 注释\n lw $t0,4($sp)\n beq $t0,$t1,later\n la $a0,msg\n')
        self.assertEqual(sorted(r),[2,3,4],r);self.assertIn('not a recognized operator',r[2]);self.assertIn('add $t1,$t2,$t3',r[3])
        d=lines(self.p,'.text\n addd $t0\n')['diagnostics'][0];self.assertEqual((d['line'],d['column']),(2,2))
    def test_lines_that_depend_on_the_program_are_undetermined(self):
        text='.eqv SIZE 4\n.macro done\n bogus $x\n.end_macro\n.data\nv: .word 1,\n 2\ns: .asciiz "x"\n.text\nmain: addi $t0,$t0,SIZE\n done\n SIZE\n'
        r=lines(self.p,text);self.assertEqual(r['diagnostics'],[]);self.assertEqual(r['status'],'ok')
        self.assertTrue({1,2,3,4,6,7,8,9,10,11,12}<=set(r['undetermined']),r)
    def test_full_finds_what_lines_cannot(self):
        r=full(self.p,{'main.s':'.text\n.globl main\nmain: j nowhere\n'});self.assertEqual(r['status'],'ok');self.assertIn('nowhere',r['diagnostics'][0]['message'])
        self.assertEqual(full(self.p,{'main.s':'.text\nmain: nop\n'})['diagnostics'],[])
    def test_full_matches_the_real_assembler(self):
        p=subprocess.Popen(JAVA+['mars.ide.Stdio'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
        src={'main.s':'.text\n.globl main\nmain: addd $t0\n j gone\n'}
        real=ask(p,command='assemble',files=src,entry='main.s');p.stdin.close();p.wait(timeout=5)
        self.assertEqual(full(self.p,src)['diagnostics'],real['diagnostics'])
    def test_bad_requests_are_undetermined(self):
        self.assertEqual(ask(self.p,id=7,command='nope')['status'],'undetermined')
        self.assertEqual(ask(self.p,id=8,command='full',files={'../x.s':'.text\n'},entry='../x.s')['status'],'undetermined')
        self.assertEqual(ask(self.p,id=9,command='full',files={'main.s':'.include "x"\n'},entry='main.s')['status'],'undetermined')
        self.assertEqual(ask(self.p,id=10,command='full',files={'main.s':'.text\nmain: nop\n'},entry='main.s')['id'],10)
class Reset(unittest.TestCase):
    PROGRAMS=[
        ({'main.s':'.globl shared\n.data\nshared: .word 1\n.text\n.globl main\nmain: nop\n'},{}),
        ({'main.s':'.text\n.globl main\nmain: la $t0,shared\n'},{}),
        ({'main.s':'.macro m\n nop\n.end_macro\n.text\nmain: m\n'},{}),
        ({'main.s':'.text\nmain: m\n'},{}),
        ({'main.s':'.eqv N 1\n.text\nmain: li $t0,N\n'},{}),
        ({'main.s':'.text\nmain: li $t0,N\n'},{}),
        ({'a.s':'.text\n.globl main\nmain: jal f\n','b.s':'.text\n.globl f\nf: jr $ra\n'},{'entry':'a.s'}),
        ({'a.s':'.text\n.globl main\nmain: jal f\n'},{'entry':'a.s'}),
        ({'main.s':'.text\nmain: beq $t0,$t1,main\n nop\n'},{'delay':True}),
        ({'main.s':'.text\nmain: beq $t0,$t1,main\n nop\n'},{}),
    ]
    def test_each_check_matches_a_fresh_process(self):
        shared=checker()
        for files,kw in self.PROGRAMS:
            kw={'entry':'main.s',**kw}
            lone=checker();expected=full(lone,files,**kw);lone.stdin.close();lone.wait(timeout=5)
            self.assertEqual(full(shared,files,**kw),expected,files)
        shared.stdin.close();shared.wait(timeout=5)
    def test_no_temporary_files_are_left(self):
        import tempfile
        tmp=pathlib.Path(tempfile.mkdtemp());env={**os.environ,'_JAVA_OPTIONS':f'-Djava.io.tmpdir={tmp}'}
        p=subprocess.Popen(JAVA+['mars.ide.Checker'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
        full(p,{'main.s':'.text\nmain: nop\n'});self.assertEqual(list(tmp.glob('mars-teaching-*')),[]);p.stdin.close();p.wait(timeout=5)
class Service(unittest.TestCase):
    def start(self,**env):
        s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
        p=subprocess.Popen(JAVA+['mars.ide.Server',str(port)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={**os.environ,**env})
        self.addCleanup(lambda:(p.terminate(),p.wait(timeout=5)))
        for _ in range(100):
            try: socket.create_connection(('127.0.0.1',port),timeout=.2).close();break
            except OSError: time.sleep(.1)
        return port
    def post(self,port,path,body):
        r=urllib.request.Request(f'http://127.0.0.1:{port}{path}',json.dumps(body).encode(),{'Content-Type':'application/json'})
        return json.load(urllib.request.urlopen(r,timeout=20))
    def test_checks_leave_a_paused_program_alone(self):
        port=self.start()
        src={'main.s':'.data\nv: .word 7\n.text\n.globl main\nmain:\n lw $t0,v\n addi $t0,$t0,1\n sw $t0,v\n li $v0,10\n syscall\n'}
        self.post(port,'/api',{'command':'assemble','files':src,'entry':'main.s'})
        for _ in range(3): self.post(port,'/api',{'command':'step'})
        snap=lambda:self.post(port,'/api',{'command':'memory','address':0x10010000,'length':64})
        before=snap();self.assertEqual(before['step'],3)
        for files in ({'main.s':'.data\nv: .word 99\n.text\nmain: nop\n'},{'main.s':'.text\nmain: j gone\n'}):
            for _ in range(3):
                self.assertEqual(self.post(port,'/api/check',{'id':1,'command':'full','files':files,'entry':'main.s'})['status'],'ok')
        self.post(port,'/api/check',{'id':2,'command':'line','file':'main.s','text':'.text\n addd\n','lines':[2]})
        self.assertEqual(snap(),before)
        self.assertEqual(self.post(port,'/api',{'command':'seek','step':1})['step'],1)
        self.assertEqual(self.post(port,'/api',{'command':'seek','step':3})['step'],3)
    def test_a_hung_checker_costs_one_answer_and_not_the_session(self):
        port=self.start(MARS_CHECKER_COMMAND='sleep 100')
        self.post(port,'/api',{'command':'assemble','files':{'main.s':'.text\nmain: nop\n'},'entry':'main.s'})
        t=time.time();r={}
        import threading
        hung=threading.Thread(target=lambda:r.update(self.post(port,'/api/check',{'id':5,'command':'line','file':'a.s','text':'','lines':[]})));hung.start()
        time.sleep(.3);self.assertEqual(self.post(port,'/api',{'command':'state'})['status'],'paused');self.assertLess(time.time()-t,2)
        hung.join();self.assertEqual((r['status'],r['id']),('undetermined',5));self.assertGreater(time.time()-t,4)
        self.assertEqual(self.post(port,'/api',{'command':'state'})['status'],'paused')
    def test_a_dead_checker_is_replaced(self):
        port=self.start(MARS_CHECKER_COMMAND='true')
        for _ in range(2): self.assertEqual(self.post(port,'/api/check',{'id':1,'command':'line','file':'a.s','text':'','lines':[]})['status'],'undetermined')
if __name__=='__main__':unittest.main(verbosity=2)
