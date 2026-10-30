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

def project_action(page, name):
    """Project actions live in the 工程 menu (classroom 2026-10-24)."""
    if page.locator('#project-menu').is_hidden():
        page.locator('#project-menu-button').click()
    page.locator('#'+name).click()

def upload(page, entries, add=False):
    project_action(page, 'add-import' if add else 'import')
    with page.expect_file_chooser() as chooser:
        page.locator('#choose-files').click()
    chooser.value.set_files(entries)

def node(page, name):
    page.locator(f'[data-node="{name}"]').click()

def program(value):
    return f'.text\n.globl main\nmain:\nli $a0,{value}\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n'

def assemble_and_run(page, output):
    page.locator('#assemble').click()
    page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
    page.locator('#run').click()
    page.wait_for_function("() => window.marsIDE.state?.status === 'ended'")
    return page.locator('#output').inner_text()==output

def choose_mode(page, mode):
    page.locator('#assemble-mode').click()
    page.locator(f'[data-assembly-mode="{mode}"]').click()

def scope_checks(page, temp):
    """P0: auto assembly by default; single file and a manual scope on demand."""
    course=temp/'course';(course/'nested').mkdir(parents=True)
    (course/'hello.s').write_text(program(1));(course/'nested/hexOut.s').write_text(program(2))
    project_action(page,'import')
    with page.expect_file_chooser() as chooser:
        page.locator('#choose-folder').click()
    chooser.value.set_files(str(course));confirm(page)
    check('imported exercises use auto assembly by default',page.locator('#assembly-mode-name').inner_text()=='自动汇编' and page.locator('[data-joint]').count()==0)
    page.locator('#assemble-mode').click()
    check('the menu beside the assemble button marks the current way',page.locator('[data-assembly-mode="auto"]').get_attribute('aria-checked')=='true' and page.locator('#assemble-menu').is_visible())
    page.keyboard.press('Escape')
    check('Escape closes the assembly menu',page.locator('#assemble-menu').is_hidden())
    page.locator('[data-file="course/hello.s"]').click()
    check('two exercises that both define main: the open one assembles and runs alone',assemble_and_run(page,'1') and page.locator('[data-file="course/nested/hexOut.s"]').count()==1)
    check('the editor names the loaded program',page.locator('#target').inner_text()=='程序：course/hello.s')
    page.locator('.cm-line').nth(3).click();page.keyboard.press('F9')
    page.locator('[data-file="course/nested/hexOut.s"]').click()
    banner=page.locator('#scope-banner')
    check('switching exercises says the loaded program is another file and blocks running it',banner.is_visible() and '你在看 course/nested/hexOut.s，现在能运行的是 course/hello.s' in banner.inner_text() and '不会运行旧程序' not in banner.inner_text() and page.locator('#back').is_disabled())
    step=page.evaluate('window.marsIDE.state.step');page.keyboard.press('Shift+F9');page.keyboard.press('F5');page.wait_for_timeout(300)
    check('keys do not silently drive the previous program',page.evaluate('window.marsIDE.state.step')==step)
    banner.locator('[data-scope-action="assemble"]').click()
    page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
    page.locator('#run').click();page.wait_for_function("() => window.marsIDE.state?.status === 'ended'")
    check('the banner assembles the exercise being viewed, without a duplicate main',page.locator('#output').inner_text()=='2' and not page.evaluate('window.marsIDE.state.diagnostics.length'))
    check('breakpoints in a file outside the assembly stay listed but inactive','未参与汇编' in page.locator('#breakpoints').inner_text())
    page.locator('[data-file="course/hello.s"]').click()
    write(page,program(3))
    page.locator('[data-file="course/nested/hexOut.s"]').click()
    check('editing another exercise does not invalidate the loaded program',not page.locator('#back').is_disabled() and not banner.is_visible())
    page.locator('[data-file="course/hello.s"]').click();banner.locator('[data-scope-action="assemble"]').click()
    page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
    check('a kept breakpoint is active again once its file is assembled','未参与汇编' not in page.locator('#breakpoints').inner_text() and 'course/hello.s:4' in page.locator('#breakpoints').inner_text())
    lab=[('lab/main.s','.text\n.globl main\nmain:\njal helper\nnop\nmove $a0,$v0\nli $v0,1\nsyscall\nli $v0,10\nsyscall\n'),('lab/helper.s','.text\n.globl helper\nhelper:\nli $v0,7\njr $ra\nnop\n')]
    upload(page,[{'name':n,'mimeType':'text/plain','buffer':t.encode()} for n,t in lab],add=True)
    page.wait_for_function("() => Object.hasOwn(window.marsIDE.files,'lab/helper.s')")
    page.locator('[data-file="lab/main.s"]').click()
    page.locator('#assemble').click();page.wait_for_function("() => window.marsIDE.state?.status === 'paused'")
    check('auto assembly links the helper that main uses, and nothing else',page.locator('#target').inner_text()=='程序：lab/main.s ＋1 个文件' and page.evaluate("window.marsIDE.state.files && Object.keys(window.marsIDE.state.files).sort().join()")=='lab/helper.s,lab/main.s')
    page.locator('#source').click();page.wait_for_function("() => document.querySelector('.file-tab.active')?.textContent.startsWith('lab/helper.s')")
    check('following execution into a linked file is not treated as switching away',not banner.is_visible())
    page.locator('#run').click();page.wait_for_function("() => window.marsIDE.state?.status === 'ended'")
    check('main plus helper run together while other exercises stay out',page.locator('#output').inner_text()=='7')
    choose_mode(page,'single')
    check('changing the way of assembling marks the loaded program out of date','汇编方式改成了单文件汇编，但现在能运行的还是之前装入的程序（lab/main.s 和另外 1 个文件）' in banner.inner_text() and page.locator('#back').is_disabled() and page.locator('#assembly-mode-name').inner_text()=='单文件汇编')
    page.locator('[data-file="lab/main.s"]').click();page.locator('#assemble').click()
    page.wait_for_function("() => window.marsIDE.state?.status === 'error'")
    check('single-file assembly names the file that defines a missing label','helper 定义在 lab/helper.s，单文件汇编不会加入它' in page.locator('#banner').inner_text())
    choose_mode(page,'manual')
    check('a manual scope starts from what auto assembly would use',page.locator('[data-joint="lab/helper.s"]').is_checked() and page.locator('[data-joint="lab/main.s"]').is_checked() and not page.locator('[data-joint="course/hello.s"]').is_checked() and page.locator('#entry-file').input_value()=='lab/main.s')
    check('the manual scope runs',assemble_and_run(page,'7'))
    page.locator('[data-file="course/hello.s"]').click()
    check('viewing an unchosen file explains it is not part of the program','course/hello.s 不在手动选择的范围里，现在能运行的是 lab/main.s 和另外 1 个文件' in banner.inner_text())
    banner.locator('[data-scope-action="back"]').click()
    check('the banner returns to the loaded program',page.locator('.file-tab.active').inner_text().startswith('lab/') and not banner.is_visible())
    page.locator('[data-joint="course/hello.s"]').check()
    check('changing the manual selection marks the loaded program out of date','手动选择的范围改了' in banner.inner_text() and page.locator('#back').is_disabled())
    page.locator('#assemble').click();page.wait_for_function("() => window.marsIDE.state?.status === 'error'")
    text=page.locator('#banner').inner_text()
    check('two chosen mains are diagnosed with the files involved','course/hello.s' in text and 'lab/main.s' in text and '都定义了全局标签 main' in text)
    page.locator('[data-joint="course/hello.s"]').uncheck()
    page.reload();page.wait_for_function('() => Boolean(window.marsIDE)')
    check('refresh keeps the manual scope and its entry',page.locator('#assembly-mode-name').inner_text()=='手动选择范围' and page.locator('[data-joint="lab/helper.s"]').is_checked() and not page.locator('[data-joint="course/hello.s"]').is_checked() and page.locator('#entry-file').input_value()=='lab/main.s')
    check('the reopened project still assembles the manual scope',assemble_and_run(page,'7'))
    choose_mode(page,'auto')
    page.locator('[data-file="course/nested/hexOut.s"]').click()
    check('back in auto mode the open exercise assembles alone',assemble_and_run(page,'2'))
    upload(page,[{'name':n,'mimeType':'text/plain','buffer':t.encode()} for n,t in [('pair/a.s',program(4)),('pair/b.s',program(5)),('pair/util.s','.text\nutil:\njr $ra\n')]],add=True)
    page.wait_for_function("() => Object.hasOwn(window.marsIDE.files,'pair/util.s')")
    page.locator('[data-file="pair/util.s"]').click();page.locator('#assemble').click()
    page.wait_for_function("() => document.getElementById('banner').textContent.includes('多个文件定义了 main')")
    check('auto reports only the undecidable case: no main here and several in the folder',True)
    page.locator('[data-file="pair/b.s"]').click()
    check('opening one of several mains makes it the only main source',assemble_and_run(page,'5'))

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
            check('imported non-main.s file assembles and runs as the current file',page.locator('#output').inner_text()=='42')
            page.locator('#new-folder').click();form(page,'src')
            node(page,'src');page.locator('#node-new-file').click();form(page,'src/helper.s')
            write(page,'.text\nhelper:\njr $ra\nnop\n')
            choose_mode(page,'manual')
            check('a manual scope starts from the file being edited',page.locator('[data-joint="src/helper.s"]').is_checked() and not page.locator('[data-joint="student.s"]').is_checked())
            page.locator('#entry-file').select_option('src/helper.s')
            node(page,'src');page.locator('#node-rename').click();form(page,'lib')
            check('renaming a folder moves sources and entry together',page.locator('[data-file="lib/helper.s"]').count()==1 and page.locator('#entry-file').input_value()=='lib/helper.s')
            check('rename preserves the currently edited content',page.evaluate("window.marsIDE.files['lib/helper.s']").startswith('.text\nhelper:'))
            page.locator('[data-joint="student.s"]').check()
            page.locator('#entry-file').select_option('student.s')
            page.locator('#new-folder').click();form(page,'empty')
            node(page,'lib/helper.s');page.locator('#node-rename').click();form(page,'lib/moved.s')
            check('file rename keeps its text',page.evaluate("window.marsIDE.files['lib/moved.s']").startswith('.text\nhelper:'))
            upload(page,[{'name':'student.s','mimeType':'text/plain','buffer':b'# replacement'}],add=True)
            page.locator('#project-cancel').click()
            check('cancelling an import collision preserves existing content',page.evaluate("window.marsIDE.files['student.s']")==SOURCE)
            upload(page,[{'name':'student.s','mimeType':'text/plain','buffer':b'# replacement'}],add=True);confirm(page)
            check('explicit collision overwrite is applied',page.evaluate("window.marsIDE.files['student.s']")=='# replacement')
            project_action(page,'restore-project');confirm(page)
            check('restore recovers the previous project contents',page.evaluate("window.marsIDE.files['student.s']")==SOURCE)
            page.locator('[data-file="student.s"]').click()
            with page.expect_download() as result:
                project_action(page,'export-file')
            path=Path(temp)/'student.s';result.value.save_as(path)
            check('individual source download contains current edits',path.read_text()==SOURCE)
            project_action(page,'save')
            with page.expect_download() as result:
                page.locator('#download-zip').click()
            archive=Path(temp)/'project.zip';result.value.save_as(archive)
            with zipfile.ZipFile(archive) as z:
                check('ZIP has original source, UTF-8 data, empty folder and entry metadata',z.read('student.s').decode()==SOURCE and z.read('input.txt').decode()=='你好\n' and 'empty/' in z.namelist() and json.loads(z.read('.mars-project.json'))['entry']=='student.s' and json.loads(z.read('.mars-project.json'))['assembly']=={'mode':'manual','files':['lib/moved.s','student.s']})
            project_action(page,'save')
            with page.expect_download() as result:
                page.locator('#download-json').click()
            exported=Path(temp)/'project.json';result.value.save_as(exported)
            check('JSON export includes entry and nested source paths',json.loads(exported.read_text())['entry']=='student.s' and 'lib/moved.s' in json.loads(exported.read_text())['files'])
            node(page,'lib');page.locator('#node-delete').click();confirm(page)
            check('delete folder removes all descendants',not page.evaluate("Object.keys(window.marsIDE.files).some(x=>x.startsWith('lib/'))"))
            project_action(page,'restore-project');confirm(page)
            check('deleted folder and descendants can be restored',page.evaluate("Object.hasOwn(window.marsIDE.files,'lib/moved.s')"))
            project_action(page,'new-project');confirm(page)
            check('new project removes previous source and data files',page.evaluate('Object.keys(window.marsIDE.files)')==['main.s'] and page.locator('[data-data]').count()==0)
            upload(page,[str(archive)]);confirm(page)
            check('ZIP reimport restores the complete project',page.evaluate("window.marsIDE.files['student.s']")==SOURCE and page.locator('[data-folder="empty"]').count()==1)
            page.reload();page.wait_for_function('() => Boolean(window.marsIDE)')
            check('refresh restores paths, data, manual scope and entry',page.locator('#assembly-mode-name').inner_text()=='手动选择范围' and page.evaluate("window.marsIDE.files['student.s']")==SOURCE and page.locator('#entry-file').input_value()=='student.s' and page.locator('[data-data="input.txt"]').count()==1)
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
            project_action(page,'import')
            with page.expect_file_chooser() as chooser:
                page.locator('#choose-folder').click()
            chooser.value.set_files(str(folder));confirm(page)
            check('native folder picker keeps relative paths and ignores macOS metadata',page.evaluate("window.marsIDE.files['folder-project/main.s']")==SOURCE and page.locator('[data-data="folder-project/assets/input.txt"]').count()==1)
            scope_checks(page,Path(temp))
            project_action(page,'restore-project');confirm(page)
            page.set_viewport_size({'width':1024,'height':800})
            page.locator('#project-menu-button').click()
            check('project actions remain reachable at a smaller desktop width',page.locator('#import').is_visible() and page.locator('#new-project').is_visible())
            page.keyboard.press('Escape')
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
            project_action(quota,'new-project');confirm(quota)
            project_action(quota,'restore-project');confirm(quota)
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
