"""Run the existing core scenarios against TeaVM; bounded-JVM-heap check stays JVM-only."""
import json,subprocess,unittest
from core_test import CoreTests,ROOT
class BrowserCoreTests(CoreTests):
 @classmethod
 def setUpClass(cls):
  cls.p=subprocess.Popen(['node','teaching/tests/browser_stdio.cjs','--plain'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
 def test_output_history_with_bounded_heap(self):
  src='.data\nmsg: .asciiz "'+('x'*100)+'\\n"\n.text\nmain:\nli $s0,2000\nla $a0,msg\nloop:\nli $v0,4\nsyscall\naddiu $s0,$s0,-1\nbnez $s0,loop\nli $v0,10\nsyscall\n'
  self.asm(src);state=self.finish()
  self.assertEqual(state['status'],'ended');self.assertEqual(state['output'],('x'*100+'\n')*2000)
  end=state['step'];self.assertEqual(self.call('seek',step=0)['output'],'')
  self.assertEqual(self.call('seek',step=end)['output'],state['output'])
  self.call('seek',step=20)
  self.assertEqual(self.call('run',limit=10)['output'],('x'*100+'\n')*7)
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(BrowserCoreTests))
 raise SystemExit(not result.wasSuccessful())
