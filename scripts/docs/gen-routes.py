# Run from repo root: python3 scripts/docs/gen-routes.py  -> docs/ROUTES.md
import re,collections
s=open('src/App.tsx').read()
i=s.index('<Routes>');s=s[i:]
rows=[];stack=[];pos=0
guards=['ProtectedRoute','StaffRoute','TechnicianRoute','PartnerRoute']
while True:
    m=re.search(r'<Route\b|</Route>|<Routes>|</Routes>',s[pos:])
    if not m:break
    st=pos+m.start();tag=m.group(0)
    if tag=='</Route>':
        if stack:stack.pop()
        pos=st+len(tag);continue
    if tag in('<Routes>','</Routes>'):pos=st+len(tag);continue
    # read tag until matching '>' outside braces
    j=st+len(tag);depth=0;q=None
    while j<len(s):
        c=s[j]
        if q:
            if c==q:q=None
        elif c in '"\'`' and depth>0:q=c
        elif c=='{':depth+=1
        elif c=='}':depth-=1
        elif c=='>' and depth==0:break
        j+=1
    t=s[st:j+1];selfclose=t.endswith('/>')
    pm=re.search(r'path="([^"]+)"',t);idx='index' in re.findall(r'\s(index)\b',t)
    g=[x for x in guards if x in t]
    inherited=[x for lst in stack for x in lst]
    el=re.search(r'element=\{(.*)\}',t,re.S)
    comp='';redir=''
    if el:
        e=el.group(1)
        rm=re.search(r'Navigate to="([^"]+)"',e)
        if rm:redir=rm.group(1)
        cm=re.findall(r'<([A-Z]\w+)',e)
        cm=[c for c in cm if c not in guards+['Suspense','Navigate'] and not c.endswith('Fallback')]
        comp=cm[0] if cm else ''
    if pm or idx:
        rows.append((pm.group(1) if pm else '(index)',comp,redir,g or inherited))
    if not selfclose:stack.append(g)
    pos=j+1
by=collections.Counter()
o=['# Route map (generated)','','> Generated from `src/App.tsx`. Guard = `<ProtectedRoute>` (session + session/IP policy), `<StaffRoute>` (Vireek staff), `<TechnicianRoute>`, `<PartnerRoute>`; "public" means no guard wrapper was found in the route or its parent routes. **Guards in nested layout components or in the page itself are not visible to this scan.** Role/plan checks inside pages are not listed.','',f'Routes found: **{len(rows)}**.','','| Path | Component / redirect | Guard |','|---|---|---|']
for p,c,r,g in rows:
    gg=', '.join(dict.fromkeys(g)) or 'public'
    by[gg]+=1
    o.append(f"| `{p}` | {('→ `'+r+'`') if r else ('`'+c+'`' if c else '—')} | {gg} |")
o+=['','## Totals by guard','','| Guard | Routes |','|---|---|']+[f'| {k} | {v} |' for k,v in by.most_common()]
open('docs/ROUTES.md','w').write('\n'.join(o))
print(len(rows),by)
