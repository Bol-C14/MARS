"""Generated files join the tree without overwriting project inputs; isolated browser only."""
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from browser_acceptance import launch
from playwright.sync_api import sync_playwright
src='.data\nname: .asciiz "MIPS/output.txt"\ntext: .asciiz "OK"\n.text\n.globl main\nmain:\nla $a0,name\nli $a1,1\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,text\nli $a2,2\nli $v0,15\nsyscall\nli $v0,10\nsyscall\n'
project={'name':'Output check','files':{'main.s':src},'data':{'MIPS/output.txt':'ORIGINAL','MIPS/input.txt':'KEEP'},'entry':'main.s','activeFile':'main.s','openTabs':['main.s']}
with sync_playwright() as p:
 b=launch(p)
 try:
  page=b.new_page();page.add_init_script('localStorage.setItem("mars-trace:project:v2",'+json.dumps(json.dumps(project))+')')
  page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/');page.wait_for_function('()=>Boolean(window.marsIDE)')
  page.locator('#assemble').click();page.wait_for_function('()=>window.marsIDE.state?.status==="paused"')
  page.locator('#run').click();page.wait_for_function('()=>window.marsIDE.state?.status==="ended"')
  row=page.locator('.file-tree [data-generated="MIPS/output.txt"]');row.wait_for()
  assert page.locator('[data-folder="MIPS"] [data-generated="MIPS/output.txt"]').count()==1
  assert page.locator('.tree-name',has_text='output.txt').count()==1
  row.click();assert page.locator('#modal pre').inner_text()=='OK'
  with page.expect_download() as dl:page.locator('#download-generated').click()
  assert open(dl.value.path(),'rb').read()==b'OK'
  page.locator('#view-original-input').click();assert 'ORIGINAL' in page.locator('#modal').inner_text() or page.locator('#modal textarea').input_value()=='ORIGINAL'
  saved=json.loads(page.evaluate('localStorage.getItem("mars-trace:project:v2")'))
  assert saved['data']['MIPS/output.txt']=='ORIGINAL' and saved['data']['MIPS/input.txt']=='KEEP' and saved['files']['main.s']==src
  print('PASS: output in existing MIPS tree, one node, correct preview/download; original input and source unchanged')
 finally:b.close()
