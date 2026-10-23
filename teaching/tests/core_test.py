"""Real MARS execution integration tests over the JSON-lines adapter."""
import json, pathlib, subprocess, unittest, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
class CoreTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.p=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Stdio'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
 @classmethod
 def tearDownClass(cls): cls.p.terminate();cls.p.wait(timeout=5)
 def call(self,command,**kw):
  self.p.stdin.write(json.dumps(dict(command=command,**kw))+'\n');self.p.stdin.flush();s=json.loads(self.p.stdout.readline());self.assertIn('protocol',s,s);return s
 def asm(self,source=None,example=None,**kw):
  files={'main.s':source} if source else {p.name:p.read_text() for p in (ROOT/'teaching/examples'/example).glob('*.s')}
  return self.call('assemble',files=files,entry='main.s',**kw)
 def finish(self):
  for _ in range(200):
   s=self.call('run',limit=1000)
   if s['status']!='paused': return s
   self.assertEqual(s['stopReason'],'Batch complete',s['stopReason'])
  self.fail('Execution budget exceeded')
 def test_hexout_and_rewind(self):
  for delay in (False,True):
   self.asm(example='hexout',inputs=['898'],delay=delay);s=self.finish();self.assertEqual(s['output'],'Enter an integer: Hex: 00000382');self.assertEqual(s['status'],'ended');n=s['step'];self.call('seek',step=0);replay=self.call('seek',step=n);self.assertEqual(replay['output'],s['output']);self.call('seek',step=0);self.assertEqual(self.finish()['output'],s['output'])
 def test_task1_files(self):
  for delay in (False,True):
   for content,expected,code in [('Hi','Hi',0),('','',0),('A\0B','A',0),(None,'Error opening file',-1)]:
    self.asm(example='task1',delay=delay,data={} if content is None else {'input.txt':content});s=self.finish();self.assertEqual(s['output'],expected);self.assertEqual(s['exitCode'],code);self.assertEqual(s['registers'][29]['value'],0x7fffeffc);n=s['step'];self.call('seek',step=0);self.assertEqual(self.call('seek',step=n)['output'],expected)
 def test_same_value_write_and_read(self):
  s=self.asm('.text\n.globl main\nmain:\n addiu $t0,$zero,0\n li $v0,10\n syscall\n');s=self.call('step');a=s['last']['accesses'];self.assertTrue(any(x.get('name')=='$t0' and x['write'] and x['before']==x['value']==0 for x in a));self.assertTrue(any(x.get('name')=='$zero' and not x['write'] for x in a));self.assertEqual(s['step'],1)
 def test_memory_preview_and_undo(self):
  self.asm('.data\nx: .word 7\n.text\n.globl main\nmain:\n la $t0,x\n li $t1,9\n sw $t1,0($t0)\n lw $t2,0($t0)\n li $v0,10\n syscall\n')
  for _ in range(3):s=self.call('step')
  self.assertEqual(s['preview']['instruction']['op'],'sw');self.assertEqual(s['memory'][0]['value'],7)
  for _ in range(3):self.assertEqual(self.call('state')['memory'][0]['value'],7)
  s=self.call('step');self.assertEqual(s['memory'][0]['value'],9);s=self.call('back');self.assertEqual(s['memory'][0]['value'],7);s=self.call('step');s=self.call('step');self.assertEqual(s['registers'][10]['value'],9);self.assertTrue(any(a['kind']=='memory' and not a['write'] for a in s['last']['accesses']))
 def test_wait_does_not_consume_input(self):
  self.asm('.text\nmain:\nli $v0,5\nsyscall\nmove $s0,$v0\nli $v0,10\nsyscall\n');self.call('step');s=self.call('step');self.assertEqual(s['status'],'waiting');self.assertEqual(s['step'],1);s=self.call('input',value='42');self.assertEqual(s['inputCursor'],0);self.assertEqual(s['preview']['status'],'waiting-input');s=self.call('step');self.assertEqual(s['registers'][2]['value'],42);self.assertEqual(s['inputCursor'],1);s=self.call('back');self.assertEqual(s['inputCursor'],0);self.assertEqual(self.call('step')['registers'][2]['value'],42)
 def test_delayed_branch_preview_undo(self):
  self.asm('.text\nmain:\nli $t0,1\nj target\naddiu $t0,$t0,2\nli $t0,99\ntarget:\nli $v0,10\nsyscall\n',delay=True);self.call('step');s=self.call('step');self.assertEqual(s['last']['delayAfter'][0],2);pc=s['pc'];s=self.call('step');self.assertEqual(s['registers'][8]['value'],3);self.call('back');s=self.call('state');self.assertEqual(s['pc'],pc);s=self.call('step');self.assertEqual(s['registers'][8]['value'],3)
 def test_breakpoint_and_watch(self):
  s=self.asm('.text\nmain:\nli $t0,3\nloop:\naddiu $t0,$t0,-1\nbnez $t0,loop\nnop\nli $v0,10\nsyscall\n');addr=next(i['address'] for i in s['instructions'] if i['line']==5)
  s=self.call('run',breakpoints=[{'address':addr,'condition':'$t0 == 2'}]);self.assertEqual(s['registers'][8]['value'],2);self.assertEqual(s['pc'],addr);s=self.call('run',skipBreakpoint=True,watches=[{'register':'$t0','access':'write'}]);self.assertEqual(s['registers'][8]['value'],1);self.assertIn('Watchpoint',s['stopReason'])
 def test_source_step_pseudo_and_inner_breakpoint(self):
  s=self.asm('.text\nmain:\nli $t0,0x12345678\nli $v0,10\nsyscall\n');self.assertEqual(s['instructions'][0]['line'],s['instructions'][1]['line']);s=self.call('source',breakpoints=[{'address':s['instructions'][1]['address'],'condition':''}]);self.assertEqual(s['step'],1);self.assertIn('Breakpoint',s['stopReason']);s=self.call('source',skipBreakpoint=True);self.assertEqual(s['registers'][8]['value'],0x12345678)
 def test_exception_and_zero_register(self):
  self.asm('.text\nmain:\nli $zero,7\nlw $t0,1($zero)\n');s=self.call('step');self.assertEqual(s['registers'][0]['value'],0);s=self.call('step');self.assertEqual(s['status'],'error');self.assertIn('aligned',s['error']);self.call('back');self.assertEqual(self.call('state')['status'],'paused')
 def test_assembly_diagnostic(self):
  s=self.asm('.text\nmain:\nthis_is_not_an_instruction $t0\n');self.assertEqual(s['status'],'error');self.assertTrue(s['diagnostics']);self.assertEqual(s['diagnostics'][0]['file'],'main.s')
 def test_cross_file_step_over_out(self):
  for delay in (False,True):
   s=self.asm(example='task1',data={'input.txt':'Hi'},delay=delay)
   jal=next(i for i in s['instructions'] if i['file']=='main.s' and i['op']=='jal')
   s=self.call('run',breakpoints=[{'address':jal['address'],'condition':''}]);self.assertEqual(s['pc'],jal['address'])
   s=self.call('over',limit=100000,skipBreakpoint=True);self.assertEqual(s['pc'],jal['address']+(8 if delay else 4));self.assertEqual(s['output'],'Hi')
   self.call('seek',step=0);self.call('run',breakpoints=[{'address':jal['address'],'condition':''}]);s=self.call('step')
   if delay:s=self.call('step')
   s=self.call('out',limit=100000);self.assertEqual(s['pc'],jal['address']+(8 if delay else 4));self.assertEqual(s['output'],'Hi')
 def test_read_watch_and_same_value_memory_write(self):
  self.asm('.data\nx: .word 7\n.text\nmain:\nla $t0,x\nli $t1,7\nsw $t1,0($t0)\nlw $t2,0($t0)\nli $v0,10\nsyscall\n')
  s=self.call('run',watches=[{'address':0x10010002,'access':'write'}]);self.assertIn('Watchpoint',s['stopReason']);a=next(a for a in s['last']['accesses'] if a['kind']=='memory' and a['write']);self.assertEqual(a['before'],a['value']);self.assertEqual(s['lastWriters']['mem:268500994'],s['step']);s=self.call('run',watches=[{'address':0x10010000,'access':'read'}]);self.assertEqual(s['last']['instruction']['op'],'lw')
 def test_loop_counts_and_independent_example(self):
  for delay in (False,True):
   self.asm(example='array-sum',delay=delay);s=self.finish();self.assertEqual(s['output'],'18');loop=s['loops'][0];self.assertEqual(loop['backJumps'],4);self.assertEqual(loop['entries'],5);self.assertEqual(len(s['calls']),0)
 def test_unknown_service_never_runs(self):
  self.asm('.text\nmain:\nli $v0,30\nsyscall\n');self.call('step');s=self.call('step');self.assertEqual(s['status'],'error');self.assertIn('unsupported',s['error'])
 def test_undo_virtual_write(self):
  self.asm('.data\nname: .asciiz "out.txt"\ntext: .asciiz "OK"\n.text\nmain:\nla $a0,name\nli $a1,1\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,text\nli $a2,2\nli $v0,15\nsyscall\nli $v0,10\nsyscall\n')
  for _ in range(20):
   s=self.call('state')
   if s['preview'].get('service')==15:break
   self.call('step')
  before=s['step'];self.assertEqual(s['handles'][0]['position'],0);s=self.call('step');self.assertEqual(s['handles'][0]['position'],2);s=self.call('seek',step=before);self.assertEqual(s['handles'][0]['position'],0);self.assertEqual(self.call('step')['handles'][0]['position'],2)
 def observable(self,s):
  return {k:s[k] for k in ('pc','step','registers','memory','output','inputCursor','handles','status','exitCode','preview')}
 def test_lookahead_matches_execution_without_side_effects(self):
  for example,kw in [('array-sum',{}),('hexout',{'inputs':['898']}),('task1',{'data':{'input.txt':'Hi'}})]:
   for delay in (False,True):
    self.asm(example=example,delay=delay,**kw);checked=0
    for _ in range(40):
     before=self.call('state');look=self.call('state',lookahead=8)['lookahead'];after=self.call('state')
     self.assertEqual(self.observable(before),self.observable(after),(example,delay))
     self.assertLessEqual(len(look['groups']),8);self.assertTrue(look['stop'])
     for g in look['groups']:
      self.assertTrue(all(e['instruction']['file']==g['file'] and e['instruction']['line']==g['line'] for e in g['events']))
     for e in [e for g in look['groups'] for e in g['events']]:
      s=self.call('step');self.assertEqual(s['last'],e,(example,delay,e['step']));checked+=1
     s=self.call('state')
     if s['status']!='paused':break
     if not look['groups']:s=self.call('step')
    self.assertGreater(checked,20,(example,delay))
 def test_lookahead_stops_at_input_without_consuming(self):
  self.asm('.text\nmain:\nli $t0,1\nli $v0,5\nsyscall\nmove $s0,$v0\n',inputs=['7'])
  look=self.call('state',lookahead=8)['lookahead'];self.assertEqual(look['stop'],'waiting-input');self.assertEqual([g['line'] for g in look['groups']],[3,4]);self.assertEqual(look['stopAt']['line'],5);self.assertTrue(look['complete'])
  s=self.call('state');self.assertEqual(s['inputCursor'],0);self.assertEqual(s['step'],0)
 def test_lookahead_groups_pseudo_lines_and_limits(self):
  self.asm('.text\nmain:\nli $t0,0x12345678\nli $t1,1\nli $t2,2\nli $v0,10\nsyscall\n')
  look=self.call('state',lookahead=2)['lookahead'];self.assertEqual(look['stop'],'window');self.assertEqual([len(g['events']) for g in look['groups']],[2,1]);self.assertEqual(look['stopAt']['line'],5)
  self.assertEqual(self.call('state',lookahead=20)['lookahead']['lines'],8)
  look=self.call('state',lookahead=8)['lookahead'];self.assertEqual(look['stop'],'ended');self.assertIsNone(look['stopAt']);self.assertEqual(len(look['groups']),5);self.assertEqual(self.call('state')['step'],0)
  self.asm('.text\nmain:\nspin: j spin\n')
  look=self.call('state',lookahead=8)['lookahead'];self.assertEqual(look['stop'],'instruction-limit');self.assertEqual(len(look['groups'][0]['events']),64);self.assertFalse(look['complete'])
  self.assertNotIn('lookahead',self.call('state'))
 def test_line_seek_moves_by_source_line(self):
  self.asm('.text\nmain:\nli $t0,0x12345678\nli $t1,1\nspin: j spin\n')
  self.call('source');self.call('source');s=self.call('step');s=self.call('step');self.assertEqual(s['step'],5)
  self.assertEqual(self.call('line',direction=-1)['step'],4);self.assertEqual(self.call('line',direction=-1)['step'],3);s=self.call('line',direction=-1);self.assertEqual(s['step'],2);self.assertEqual(s['registers'][8]['value'],0x12345678)
  self.assertEqual(self.call('line',direction=-1)['step'],0);self.assertEqual(self.call('line',direction=-1)['step'],0)
  self.assertEqual(self.call('line',direction=1)['step'],2);self.assertEqual(self.call('line',direction=1)['step'],3);self.assertEqual(self.call('line',direction=1)['step'],4);self.assertEqual(self.call('line',direction=1)['step'],5);self.assertEqual(self.call('line',direction=1)['step'],5)
 def test_hit_count_and_logpoint(self):
  s=self.asm('.text\nmain:\nli $t0,3\nloop:\naddiu $t0,$t0,-1\nbnez $t0,loop\nnop\nli $v0,10\nsyscall\n');addr=next(i['address'] for i in s['instructions'] if i['line']==5)
  for _ in range(2):
   s=self.call('run',breakpoints=[{'address':addr,'hit':3}]);self.assertEqual(s['pc'],addr);self.assertEqual(s['registers'][8]['value'],1);self.assertIn('Breakpoint',s['stopReason'])
   self.call('seek',step=0)
  s=self.call('run',breakpoints=[{'address':addr,'log':'t0={$t0} {$t0:x}'}]);self.assertEqual(s['status'],'ended')
  self.assertEqual([l['text'] for l in s['logs']],['t0=3 0x00000003','t0=2 0x00000002','t0=1 0x00000001'])
  self.assertEqual(self.call('state')['logs'],[])
 def test_input_echo_and_visit_count(self):
  self.asm('.text\nmain:\nli $v0,4\nla $a0,p\nsyscall\nli $v0,5\nsyscall\nli $v0,10\nsyscall\n.data\np: .asciiz "N? "\n',inputs=['42'])
  s=self.finish();self.assertEqual(s['output'],'N? ');self.assertEqual(s['inputEchoes'],[{'at':3,'text':'42'}])
  self.call('seek',step=0);s=self.call('state');self.assertEqual(s['inputEchoes'],[]);self.assertEqual(s['pcVisits'],1)
  s=self.asm('.text\nmain:\nli $t0,2\nloop:\naddiu $t0,$t0,-1\nbnez $t0,loop\nnop\n');a=next(i['address'] for i in s['instructions'] if i['line']==5)
  self.call('step');self.call('step');s=self.call('step');self.assertEqual(s['pc'],a);self.assertEqual(s['pcVisits'],2)
 def test_state_and_memory_requests_keep_the_stop_reason(self):
  s=self.asm('.text\nmain:\nli $t0,1\nli $t1,2\nli $v0,10\nsyscall\n');a=next(i['address'] for i in s['instructions'] if i['line']==4)
  s=self.call('run',breakpoints=[{'address':a}]);self.assertIn('Breakpoint',s['stopReason'])
  self.assertIn('Breakpoint',self.call('state',lookahead=8)['stopReason']);self.assertIn('Breakpoint',self.call('memory',address=0x10010000)['stopReason'])
  self.assertEqual(self.call('step')['stopReason'],'')
if __name__=='__main__':unittest.main(verbosity=2)
