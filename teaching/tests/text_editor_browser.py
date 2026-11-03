"""Text files share editor/tabs; changes persist and become syscall input."""
import sys,json,zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_acceptance import launch
from workspace_browser import project_action,write
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:18765/'
source='.data\nname: .asciiz "input.txt"\nbuf: .space 4\n.text\n.globl main\nmain:\nla $a0,name\nli $a1,0\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,buf\nli $a2,1\nli $v0,14\nsyscall\nla $t0,buf\nlbu $a0,0($t0)\nli $v0,11\nsyscall\nli $v0,10\nsyscall\n'
project={'name':'Text editor check','files':{'main.s':source},'data':{'input.txt':'A\n'},'entry':'main.s','activeFile':'main.s','openTabs':['main.s']}
with sync_playwright() as p:
 b=launch(p)
 try:
  page=b.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.add_init_script('if(!localStorage.getItem("mars-trace:project:v2"))localStorage.setItem("mars-trace:project:v2",'+json.dumps(json.dumps(project))+')')
  page.goto(URL);page.wait_for_function('()=>Boolean(window.marsIDE)')
  page.locator('[data-data="input.txt"]').click()
  assert not page.locator('#modal').is_visible()
  assert page.locator('[data-tab="input.txt"]').count()==1 and page.locator('.cm-content').inner_text().strip()=='A'
  write(page,'Z\n');page.keyboard.press('Meta+S' if sys.platform=='darwin' else 'Control+S')
  saved=page.evaluate('JSON.parse(localStorage.getItem("mars-trace:project:v2"))')
  assert saved['data']['input.txt']=='Z\n' and saved['files']==project['files']
  assert 'input.txt' in saved['openTabs'] and saved['activeFile']=='input.txt'
  page.reload();page.wait_for_function('()=>Boolean(window.marsIDE)')
  assert page.locator('.file-tab.active [data-tab="input.txt"]').count()==1 and page.locator('.cm-content').inner_text().strip()=='Z'
  page.keyboard.press('Meta+P' if sys.platform=='darwin' else 'Control+P');page.locator('#picker-input').fill('input.txt');page.locator('#picker-list .command-item').first.click()
  assert page.locator('.file-tab.active [data-tab="input.txt"]').count()==1
  page.locator('#assemble').click();page.wait_for_function('()=>window.marsIDE.state?.status==="paused"')
  assert page.evaluate('Object.keys(window.marsIDE.state.files)')==['main.s']
  page.locator('#run').click();page.wait_for_function('()=>window.marsIDE.state?.status==="ended"')
  assert page.locator('#output').inner_text()=='Z'
  page.locator('[data-data="input.txt"]').click();project_action(page,'save')
  with page.expect_download() as d:page.locator('#download-zip').click()
  with zipfile.ZipFile(d.value.path()) as z:
   assert z.read('input.txt').decode()=='Z\n' and z.read('main.s').decode()==source
  page.locator('[data-close-tab="input.txt"]').click()
  assert page.locator('[data-tab="input.txt"]').count()==0 and page.locator('[data-data="input.txt"]').count()==1
  page.locator('#new-file').click();page.locator('#project-value').fill('notes.txt');page.locator('#project-form button.primary').click()
  page.wait_for_function('()=>!document.getElementById("modal").open')
  assert page.locator('.file-tab.active [data-tab="notes.txt"]').count()==1
  write(page,'add $t0, not MIPS code');assert page.locator('.cm-content .cm-register').count()==0
  assert not errors,errors
  print('PASS: txt uses editor and tabs; edits persist/reload/export; new text file opens inline; syscall reads edited input; source unchanged')
 finally:b.close()
