"""Generated txt files use the same editable project files and tabs."""
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
  page=b.new_page(locale="zh-CN");page.add_init_script('localStorage.setItem("mars-trace:project:v2",'+json.dumps(json.dumps(project))+')')
  page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/');page.wait_for_function('()=>Boolean(window.marsIDE)')
  page.locator('#assemble').click();page.wait_for_function('()=>window.marsIDE.state?.status==="paused"')
  page.locator('#run').click();page.wait_for_function('()=>window.marsIDE.state?.status==="ended"')
  row=page.locator('.file-tree [data-data="MIPS/output.txt"]');row.wait_for()
  assert page.locator('[data-folder="MIPS"] [data-data="MIPS/output.txt"]').count()==1
  row.click();assert page.locator('.cm-content').inner_text()=='OK' and not page.locator('#modal').is_visible()
  assert page.locator('.cm-content').get_attribute('contenteditable')=='true'
  from workspace_browser import write,project_action
  write(page,'EDITED');page.keyboard.press('Meta+S' if sys.platform=='darwin' else 'Control+S')
  page.evaluate('window.marsIDE.command("state")')
  assert page.locator('.cm-content').inner_text()=='EDITED'
  project_action(page,'save')
  with page.expect_download() as dl:page.locator('#download-zip').click()
  import zipfile
  with zipfile.ZipFile(dl.value.path()) as z: assert z.read('MIPS/output.txt')==b'EDITED'
  saved=json.loads(page.evaluate('localStorage.getItem("mars-trace:project:v2")'))
  assert saved['data']['MIPS/output.txt']=='EDITED' and saved['data']['MIPS/input.txt']=='KEEP' and saved['files']['main.s']==src
  assert page.evaluate('window.marsIDE.state.generatedFiles["MIPS/output.txt"].base64')=='T0s='
  print('PASS: generated txt is an ordinary editable tree/tab file; save/export retain edits; state polls do not overwrite them; execution snapshot remains intact')
 finally:b.close()
