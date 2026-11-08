"""Regressions from the release review; uses only its own server and contexts."""
import asyncio, glob, json, pathlib, subprocess, sys
try:
    from playwright.async_api import async_playwright
except ImportError:
    print("SKIP release browser checks: Python Playwright is not installed")
    sys.exit(2)
from browser_acceptance import free_port
ROOT=pathlib.Path(__file__).resolve().parents[2]
DRAFT='mars-trace:project:v2'
SOURCE='.text\nmain:\nli $t0,1\nli $v0,10\nsyscall\n'

async def main():
    port=free_port();url=f'http://127.0.0.1:{port}'
    server=subprocess.Popen(['java','-Djava.awt.headless=true','-cp','teaching/build/classes','mars.ide.Server',str(port)],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        await asyncio.sleep(1)
        async with async_playwright() as p:
            paths=sorted(glob.glob(str(pathlib.Path.home()/'Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*')),reverse=True)
            browser=None
            for options in [{}, {'channel':'chrome'}, *[{'executable_path':path} for path in paths]]:
                try:
                    browser=await p.chromium.launch(**options);break
                except Exception:pass
            if browser is None:
                print('SKIP release browser checks: no Chromium/Chrome');sys.exit(2)
            async def page_for(source=SOURCE, **extras):
                ctx=await browser.new_context(viewport={'width':1280,'height':720})
                page=await ctx.new_page()
                project=dict(files={'main.s':source},data={'input.txt':'ORIGINAL'},entry='main.s',activeFile='main.s',openTabs=['main.s','input.txt'],**extras)
                await page.add_init_script('if(!localStorage.getItem('+json.dumps(DRAFT)+'))localStorage.setItem('+json.dumps(DRAFT)+','+json.dumps(json.dumps(project))+');localStorage.setItem("mars-trace:language","zh-CN");')
                await page.goto(url);await page.wait_for_function('window.marsIDE')
                return ctx,page
            ctx,page=await page_for()
            await page.evaluate('()=>{const e=marsIDE.editor;e.dispatch({changes:{from:e.state.doc.length,insert:"# edit\\n"}});}')
            await page.locator('[data-data="input.txt"]').click()
            await page.locator('.cm-content').click();await page.keyboard.press('Meta+z' if sys.platform=='darwin' else 'Control+z')
            assert (await page.locator('.cm-content').inner_text()).strip()=='ORIGINAL'
            await page.locator('[data-tab="main.s"]').click();await page.locator('.cm-content').click()
            await page.keyboard.press('Meta+z' if sys.platform=='darwin' else 'Control+z')
            assert await page.evaluate('marsIDE.files["main.s"]')==SOURCE
            await ctx.close()

            ctx,page=await page_for();await page.evaluate('marsIDE.assemble()');await page.evaluate('marsIDE.command("step")')
            arrived=asyncio.Event();release=asyncio.Event()
            async def delay(route):
                if route.request.post_data_json.get('command')=='memory':
                    response=await route.fetch();arrived.set();await release.wait();await route.fulfill(response=response)
                else:await route.continue_()
            await page.route('**/api',delay)
            await page.evaluate('()=>{window.oldMemory=marsIDE.memoryAt(0x10010000);}')
            await arrived.wait();await page.evaluate('marsIDE.assemble()')
            version=await page.evaluate('marsIDE.state.programVersion')
            release.set();await page.evaluate('window.oldMemory')
            assert await page.evaluate('marsIDE.state.programVersion')==version
            assert await page.evaluate('(async()=>{await marsIDE.command("step");return marsIDE.state.step})()')==1
            await ctx.close()

            ctx,page=await page_for()
            await page.wait_for_timeout(500)
            previous=await page.evaluate('(k)=>localStorage.getItem(k)',DRAFT)
            await page.evaluate('''key=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v)};IDBObjectStore.prototype.put=function(){throw new DOMException('Full','QuotaExceededError')};marsIDE.editor.dispatch({changes:{from:0,insert:'# changed\\n'}});}''',DRAFT)
            await page.wait_for_timeout(600)
            assert await page.evaluate('(k)=>localStorage.getItem(k)',DRAFT)==previous
            await ctx.close()

            ctx,page=await page_for('.text\nmain:\nsra $t0,$t0,1\n')
            await page.evaluate('marsIDE.assemble()');await page.evaluate('marsIDE.inspectToken("sra",{file:"main.s",line:3})')
            await page.evaluate('document.querySelector("[data-language=en]").click()')
            assert 'Arithmetic shift' in await page.locator('#context').inner_text()
            assert '算术右移' not in await page.locator('#context').inner_text()
            await page.evaluate('()=>{const e=marsIDE.editor;e.dispatch({changes:{from:0,to:e.state.doc.length,insert:".data\\nf: .float 1.5\\n.text\\nmain:\\nl.s $f12,f\\nli $v0,2\\nsyscall\\nli $v0,10\\nsyscall\\n"}});}')
            await page.evaluate('marsIDE.assemble()')
            await page.evaluate('''async()=>{const i=marsIDE.program.instructions.find(i=>i.op==='syscall');await marsIDE.command('run',{breakpoints:[{address:i.address}]});marsIDE.inspectToken('syscall',{file:i.file,line:i.line});}''')
            assert '0d0' not in await page.locator('#context').inner_text()
            assert '1069547520' in await page.locator('#context').inner_text() or '3fc00000' in await page.locator('#context').inner_text()
            await ctx.close()

            source='.text\nmain:\nli $t0,1\n'+('beq $t0,$zero,done\n'*10)+'done:\nli $v0,10\nsyscall\n'
            ctx,page=await page_for(source)
            await page.evaluate('marsIDE.assemble()');await page.locator('#focus-open').click()
            await page.locator('#focus-range').select_option('8');await page.wait_for_function('marsIDE.state?.lookahead?.groups?.length>=8')
            await page.evaluate('document.getElementById("focus-prev").onclick()')
            before=await page.locator('#focus-svg').inner_html()
            await page.evaluate('document.getElementById("focus-path").scrollTop=100')
            await page.wait_for_timeout(200)
            assert before != await page.locator('#focus-svg').inner_html()
            await ctx.close();await browser.close()
        print('PASS: independent undo, stale memory response, preserved draft on quota failure, live language change, floating syscall read, focus scroll arrows')
    finally:server.terminate();server.wait(timeout=10)

asyncio.run(main())
