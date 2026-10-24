"""Real browser workflows for file management; supports local or public URL."""
import io
import json
from pathlib import Path
import sys
import socket
import subprocess
import tempfile
import time
import zipfile
from playwright.sync_api import sync_playwright
from browser_acceptance import launch, free_port

URL = sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8768'
ROOT = Path(__file__).resolve().parents[2]
checks = []
SOURCE = '.text\n.globl main\nmain:\nli $a0,42\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n'

def check(name, condition=True):
    assert condition, name
    checks.append(name)

def confirm(page):
    page.locator('#project-confirm').click()
    page.wait_for_function("() => !document.getElementById('modal').open")

def form(page, value):
    page.locator('#project-value').fill(value)
    page.locator('#project-form button.primary').click()
    page.wait_for_function("() => !document.getElementById('modal').open")

def write(page, text):
    page.locator('.cm-content').click()
    page.keyboard.press('Meta+A' if sys.platform=='darwin' else 'Control+A')
    page.keyboard.insert_text(text)

def upload(page, entries, add=False):
    page.locator('#add-import' if add else '#import').click()
    with page.expect_file_chooser() as chooser:
        page.locator('#choose-files').click()
    chooser.value.set_files(entries)

def node(page, name):
    page.locator(f'[data-node="{name}"]').click()

def main():
    with tempfile.TemporaryDirectory() as temp, sync_playwright() as p:
        browser = launch(p)
        page = browser.new_page(viewport={'width':1440,'height':1000}, accept_downloads=True)
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        try:
            page.goto(URL)
            page.wait_for_function('() => Boolean(window.marsIDE)')
            check('first visit is a blank project with no demo', not page.evaluate("window.marsIDE.files['main.s'].includes('Hex')"))
            write(page,SOURCE)
            page.keyboard.press('Meta+S' if sys.platform=='darwin' else 'Control+S')
            page.wait_for_function("() => document.getElementById('workspace-status').textContent.includes('已保存')")
            page.reload()
            page.wait_for_function('() => Boolean(window.marsIDE)')
            check('typing and Cmd/Ctrl+S survive refresh',page.evaluate("window.marsIDE.files['main.s']") == SOURCE)
            page.locator('[data-close-tab="main.s"]').click()
            check('closing the last tab keeps the source and disables editing', page.evaluate("Object.hasOwn(window.marsIDE.files,'main.s')") and page.locator('.cm-content').get_attribute('contenteditable')=='false')
            page.locator('[data-file="main.s"]').click()
            check('closed files reopen from the tree', page.evaluate('window.marsIDE.editor.state.doc.toString()')==SOURCE)
            upload(page,[{'name':'student.s','mimeType':'text/plain','buffer':SOURCE.encode()},{'name':'input.txt','mimeType':'text/plain','buffer':'你好\n'.encode()}])
            confirm(page)
            check('open replaces the entire project without leftover demo files',page.evaluate('Object.keys(window.marsIDE.files)')==['student.s'])
            check('virtual input files appear in the same tree',page.locator('[data-data="input.txt"]').count()==1)
            page.locator('#assemble').click()
            page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
            page.locator('#run').click()
            page.wait_for_function("() => window.marsIDE.state?.status === 'ended'")
            check('imported non-main.s entry assembles and runs',page.locator('#output').inner_text()=='42')
            page.locator('#new-folder').click();form(page,'src')
            node(page,'src');page.locator('#node-new-file').click();form(page,'src/helper.s')
            write(page,'.text\nhelper:\njr $ra\nnop\n')
            page.locator('#entry-file').select_option('src/helper.s')
            node(page,'src');page.locator('#node-rename').click();form(page,'lib')
            check('renaming a folder moves sources and entry together',page.locator('[data-file="lib/helper.s"]').count()==1 and page.locator('#entry-file').input_value()=='lib/helper.s')
            check('rename preserves the currently edited content',page.evaluate("window.marsIDE.files['lib/helper.s']").startswith('.text\nhelper:'))
            page.locator('#entry-file').select_option('student.s')
            page.locator('#new-folder').click();form(page,'empty')
            node(page,'lib/helper.s');page.locator('#node-rename').click();form(page,'lib/moved.s')
            check('file rename keeps its text',page.evaluate("window.marsIDE.files['lib/moved.s']").startswith('.text\nhelper:'))
            upload(page,[{'name':'student.s','mimeType':'text/plain','buffer':b'# replacement'}],add=True)
            page.locator('#project-cancel').click()
            check('cancelling an import collision preserves existing content',page.evaluate("window.marsIDE.files['student.s']")==SOURCE)
            upload(page,[{'name':'student.s','mimeType':'text/plain','buffer':b'# replacement'}],add=True);confirm(page)
            check('explicit collision overwrite is applied',page.evaluate("window.marsIDE.files['student.s']")=='# replacement')
            page.locator('#restore-project').click();confirm(page)
            check('restore recovers the previous project contents',page.evaluate("window.marsIDE.files['student.s']")==SOURCE)
            page.locator('[data-file="student.s"]').click()
            with page.expect_download() as result:
                page.locator('#export-file').click()
            path=Path(temp)/'student.s';result.value.save_as(path)
            check('individual source download contains current edits',path.read_text()==SOURCE)
            page.locator('#save').click()
            with page.expect_download() as result:
                page.locator('#download-zip').click()
            archive=Path(temp)/'project.zip';result.value.save_as(archive)
            with zipfile.ZipFile(archive) as z:
                check('ZIP has original source, UTF-8 data, empty folder and entry metadata',z.read('student.s').decode()==SOURCE and z.read('input.txt').decode()=='你好\n' and 'empty/' in z.namelist() and json.loads(z.read('.mars-project.json'))['entry']=='student.s')
            page.locator('#save').click()
            with page.expect_download() as result:
                page.locator('#download-json').click()
            exported=Path(temp)/'project.json';result.value.save_as(exported)
            check('JSON export includes entry and nested source paths',json.loads(exported.read_text())['entry']=='student.s' and 'lib/moved.s' in json.loads(exported.read_text())['files'])
            node(page,'lib');page.locator('#node-delete').click();confirm(page)
            check('delete folder removes all descendants',not page.evaluate("Object.keys(window.marsIDE.files).some(x=>x.startsWith('lib/'))"))
            page.locator('#restore-project').click();confirm(page)
            check('deleted folder and descendants can be restored',page.evaluate("Object.hasOwn(window.marsIDE.files,'lib/moved.s')"))
            page.locator('#new-project').click();confirm(page)
            check('new project removes previous source and data files',page.evaluate('Object.keys(window.marsIDE.files)')==['main.s'] and page.locator('[data-data]').count()==0)
            upload(page,[str(archive)]);confirm(page)
            check('ZIP reimport restores the complete project',page.evaluate("window.marsIDE.files['student.s']")==SOURCE and page.locator('[data-folder="empty"]').count()==1)
            page.reload();page.wait_for_function('() => Boolean(window.marsIDE)')
            check('refresh restores paths, data and selected entry',page.evaluate("window.marsIDE.files['student.s']")==SOURCE and page.locator('#entry-file').input_value()=='student.s' and page.locator('[data-data="input.txt"]').count()==1)
            page.locator('#assemble').click();page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
            page.locator('#run').click();page.wait_for_function("() => window.marsIDE.state?.status === 'ended'")
            check('round-tripped project still executes',page.locator('#output').inner_text()=='42')
            # A malformed ZIP must fail before replacing the current project.
            bad=io.BytesIO()
            with zipfile.ZipFile(bad,'w') as z:z.writestr('../outside.s','bad')
            upload(page,[{'name':'unsafe.zip','mimeType':'application/zip','buffer':bad.getvalue()}])
            page.wait_for_selector('#modal-content:has-text("导入未完成")')
            check('failed import leaves the current project intact',page.evaluate("window.marsIDE.files['student.s']")==SOURCE)
            page.locator('#modal .close').click()
            folder=Path(temp)/'folder-project';(folder/'assets').mkdir(parents=True)
            (folder/'main.s').write_text(SOURCE)
            (folder/'assets/input.txt').write_text('folder data')
            (folder/'.DS_Store').write_bytes(b'\xff\x00')
            page.locator('#import').click()
            with page.expect_file_chooser() as chooser:
                page.locator('#choose-folder').click()
            chooser.value.set_files(str(folder));confirm(page)
            check('native folder picker keeps relative paths and ignores macOS metadata',page.evaluate("window.marsIDE.files['folder-project/main.s']")==SOURCE and page.locator('[data-data="folder-project/assets/input.txt"]').count()==1)
            page.locator('#restore-project').click();confirm(page)
            page.set_viewport_size({'width':1024,'height':800})
            check('project actions remain visible at a smaller desktop width',page.locator('#import').is_visible() and page.locator('#new-project').is_visible())
            offline_context=browser.new_context(viewport={'width':1280,'height':900})
            offline_context.route('**/examples',lambda route:route.abort())
            offline=offline_context.new_page();offline.goto(URL)
            offline.wait_for_function('() => Boolean(window.marsIDE)')
            write(offline,SOURCE)
            offline.wait_for_function("() => document.getElementById('workspace-status').textContent.includes('已保存')")
            check('editing and saving work while the example service is unavailable',offline.evaluate("window.marsIDE.files['main.s']")==SOURCE)
            offline_context.close()
            quota_context=browser.new_context(viewport={'width':1280,'height':900})
            quota_context.add_init_script("Storage.prototype.setItem=function(){throw new DOMException('storage unavailable','QuotaExceededError')}")
            quota=quota_context.new_page();quota.goto(URL)
            quota.wait_for_function('() => Boolean(window.marsIDE)')
            write(quota,SOURCE)
            quota.wait_for_function("() => document.getElementById('workspace-status').textContent.includes('未能保存')")
            check('storage failure shows an explicit export reminder',True)
            quota.locator('#new-project').click();confirm(quota)
            quota.locator('#restore-project').click();confirm(quota)
            check('in-memory recovery still works if browser storage is unavailable',quota.evaluate("window.marsIDE.files['main.s']")==SOURCE)
            quota_context.close()
            check('no browser JavaScript errors',not errors)
            target=ROOT/'teaching/test-results';target.mkdir(exist_ok=True)
            page.wait_for_timeout(250)
            page.screenshot(path=str(target/'workspace.png'))
            print(json.dumps({'url':URL,'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2))
        except Exception:
            target=ROOT/'teaching/test-results';target.mkdir(exist_ok=True)
            page.screenshot(path=str(target/'workspace-failure.png'))
            print('Passed before failure:',checks)
            print('Browser errors:',errors)
            print('Banner:',page.locator('#banner').inner_text())
            raise
        finally:
            browser.close()

if __name__=='__main__':
    if len(sys.argv)>1:
        main()
    else:
        port=free_port()
        server=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Server',str(port)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    socket.create_connection(('127.0.0.1',port),timeout=.2).close()
                    break
                except OSError:
                    time.sleep(.1)
            URL=f'http://127.0.0.1:{port}'
            main()
        finally:
            server.terminate();server.wait(timeout=5)
