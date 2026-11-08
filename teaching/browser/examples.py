"""Emit the same /examples payload as the local server, for static hosting."""
from pathlib import Path
import json
root = Path(__file__).resolve().parents[1]
examples=[]
for folder in sorted((root/'examples').iterdir()):
    if not (folder/'example.json').is_file(): continue
    example=json.loads((folder/'example.json').read_text())
    example['name']=folder.name
    languages={}
    for lang in sorted(folder.iterdir()):
        if not lang.is_dir(): continue
        files={};data={}
        for p in sorted(lang.iterdir()):
            if p.is_file() and not p.name.startswith('.'):
                (files if p.suffix in ('.s','.asm') else data)[p.name]=p.read_text()
        languages[lang.name]={'files':files,'data':data}
    example['languages']=languages
    examples.append(example)
(root/'dist/app/examples.json').write_text(json.dumps(sorted(examples,key=lambda e:e.get('order',0)),ensure_ascii=False))
