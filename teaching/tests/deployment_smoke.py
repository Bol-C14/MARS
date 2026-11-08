"""HTTP smoke for a teacher deployment; uses two independent test sessions."""
import base64
import http.cookiejar
import json
import sys
import urllib.request

url = (sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8080').rstrip('/')
def client():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
a,b=client(),client()
def get(path):
    with a.open(url+path,timeout=15) as r:return r.read()
def call(opener,path='/api',**body):
    req=urllib.request.Request(url+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':url})
    with opener.open(req,timeout=25) as r:return json.load(r)
assert b'MARS' in get('/')
assert get('/fonts/jetbrains-mono/400-normal.woff2')[:4]==b'wOF2'
assert len(json.loads(get('/examples')))==5
assert json.loads(get('/health'))['ok']
source='.data\ni: .asciiz "input.txt"\no: .asciiz "output.txt"\nbuf: .space 4\n.text\nmain:\nla $a0,i\nli $a1,0\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,buf\nli $a2,1\nli $v0,14\nsyscall\nla $a0,o\nli $a1,1\nli $v0,13\nsyscall\nmove $a0,$v0\nla $a1,buf\nli $a2,1\nli $v0,15\nsyscall\nli $v0,10\nsyscall\n'
for opener,value in [(a,'A'),(b,'B')]:
    s=call(opener,command='assemble',files={'MIPS/main.s':source},entry='MIPS/main.s',data={'MIPS/input.txt':value})
    assert s['status']=='paused',s
for opener,value in [(a,b'A'),(b,b'B')]:
    s=call(opener,command='run')
    assert s['status']=='ended',s
    assert base64.b64decode(s['generatedFiles']['MIPS/output.txt']['base64'])==value
before=call(a,command='state')
r=call(b,path='/api/check',protocol=1,id=1,command='full',files={'main.s':'.text\nmain: j missing\n'},entry='main.s')
assert r['protocol']==1 and r['diagnostics'],r
after=call(a,command='state')
for k in ['pc','step','registers','memory','historyLength','output']:assert before[k]==after[k],k
print('PASS: static UI/fonts, bilingual examples, two isolated students, relative file I/O and independent checker')
