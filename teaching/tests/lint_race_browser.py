"""Slow checker replies plus fast edits must retain every changed line."""
import json,sys
from playwright.sync_api import sync_playwright
from browser_acceptance import launch
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:18766/'
src='.text\nmain:\nli $t0,1\nli $t1,2\nj main\nnop\n'
project={'name':'Fast typing','files':{'main.s':src},'data':{},'entry':'main.s','activeFile':'main.s','openTabs':['main.s']}
with sync_playwright() as p:
 b=launch(p)
 try:
  page=b.new_page();page.add_init_script('localStorage.setItem("mars-trace:project:v2",'+json.dumps(json.dumps(project))+')')
  page.goto(URL);page.wait_for_function('()=>Boolean(window.marsIDE)')
  page.locator('#assemble').click();page.wait_for_function('()=>window.marsIDE.state?.status==="paused"')
  assert page.locator('.cm-line.delay-nop').count()==1
  page.evaluate('''()=>{const native=window.fetch;window.checked=[];let first=true;window.fetch=async function(url,init){if(String(url)==='/api/check'){const body=JSON.parse(init.body);window.checked.push(body);if(body.command==='line'&&first){first=false;await new Promise(r=>setTimeout(r,3800));}}return native.apply(this,arguments)}}''')
  def edit(n,text):
   page.evaluate('(n)=>{const e=window.marsIDE.editor,l=e.state.doc.line(n);e.dispatch({selection:{anchor:l.from,head:l.to}});e.focus()}',n)
   page.keyboard.insert_text(text)
  edit(3,'addd $t0,$t1,$t2')
  assert page.locator('.cm-line.delay-nop, .cm-line.last-line, .cm-line.next-line').count()==0
  page.wait_for_function('()=>window.checked.some(x=>x.command==="line")')
  edit(4,'li $t1,7')
  page.wait_for_function('()=>window.checked.filter(x=>x.command==="line").length>=2',timeout=10000)
  requests=page.evaluate('window.checked.filter(x=>x.command==="line")')
  assert 3 in requests[-1]['lines'] and 4 in requests[-1]['lines'],requests
  page.wait_for_function('()=>[...document.querySelectorAll(".cm-error-mark")].some(m=>m.textContent==="addd")')
  edit(3,'add $t0,$t1,$t2');edit(4,'li $t1,8')
  page.wait_for_function('()=>document.querySelectorAll(".cm-error-mark").length===0')
  page.wait_for_function('()=>window.checked.some(x=>x.command==="full")',timeout=8000)
  assert page.locator('.cm-line.delay-nop').count()==0
  print('PASS: fast edits retain pending lines across a delayed reply; error marks update and clear; full checks resume; edited code has no stale execution grey')
 finally:b.close()
