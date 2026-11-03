/*! Vireek badge v1 */
!function(){var D=document,W=window,S=D.currentScript,G=function(k,d){return S.getAttribute("data-"+k)||d};
if(!S||S._v)return;S._v=1;
var O=(S.src.match(/^https:\/\/[^/]+/)||[""])[0],V=G("variant","tiny"),
Z={tiny:[[200,28],[240,34],[290,42]],stat:[[210,36],[250,42],[300,50]],card:[[280,124],[320,136],[360,150]]}[V],
H=D.createElement("span");
if(!O||!Z||!G("slug"))return;Z=Z[{sm:0,md:1,lg:2}[G("size","md")]||0];
H.style.cssText="display:inline-block;max-width:100%;width:"+Z[0]+"px;height:"+Z[1]+"px";
S.parentNode.insertBefore(H,S.nextSibling);
function N(){H.style.display="none"}
function K(p){var c=p.map(function(c){return/^#[0-9a-f]{6}$/i.test(c)?c:"#000"});return"--b:"+c[0]+";--f:"+c[1]+";--o:"+c[2]+";--a:"+c[3]}
function E(t,a,x,k){var e=D.createElement(t),i;for(i in a)e.setAttribute(i,a[i]);if(x)e.textContent=x;(k||[]).map(function(c){e.appendChild(c)});return e}
function A(u,x,c,v){return E("a",{href:/^(https:\/\/|tel:\+\d+$)/.test(u)?u:"#",rel:v.r,target:"_blank","class":c},x)}
function R(v){if(!v||!v.p||!v.h||!/^(ok|neutral)$/.test(v.s))return N();
var r=H.attachShadow({mode:"open"}),d=v.t,m,w,k,
s=".w{box-sizing:border-box;"+K(v.p.l)+";display:flex;align-items:center;gap:8px;height:100%;padding:0 10px;background:var(--b);color:var(--f);border:1px solid var(--o);border-radius:8px;font:600 13px system-ui,sans-serif;overflow:hidden}"+
"a{color:inherit;text-decoration:none}.m{flex:1;min-width:0;display:flex;flex-direction:column}.m>*{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.y{font-weight:400;font-size:11px}"+
"a:focus-visible{outline:2px solid var(--a);outline-offset:2px}"+
".c{display:flex;gap:8px}.c a{padding:6px 12px;border-radius:6px;background:var(--a);color:var(--b)}.p{font:400 10px system-ui;text-decoration:underline}.k{flex-direction:column;align-items:stretch;justify-content:center}"+
(d=="dark"?".w{"+K(v.p.d)+"}":d=="auto"?"@media(prefers-color-scheme:dark){.w{"+K(v.p.d)+"}}":"");
m=E("span",{"class":"m"},0,[E("span",0,v.x)].concat(v.y?[E("span",{"class":"y"},v.y)]:[]));
w=E("div",{"class":"w"+(V=="card"?" k":""),dir:v.d,lang:v.l});
k=A(v.h,0,"m",v);k.setAttribute("aria-label",v.a);k.style.cssText="display:flex;align-items:center;gap:8px";
k.appendChild(m);w.appendChild(k);
if(v.c)w.appendChild(E("div",{"class":"c"},0,v.c.map(function(c){return A(c.h,c.x,"",v)})));
if(v.w)w.appendChild(A(v.w.h,v.w.x,"p",v));
try{m=new CSSStyleSheet;m.replaceSync(s);r.adoptedStyleSheets=[m]}catch(e){r.appendChild(E("style",0,s))}r.appendChild(w)}
function go(){var q=new URLSearchParams({k:G("slug"),v:V,t:G("theme","auto"),s:G("size","md"),c:G("palette","blue"),l:G("lang",navigator.language),h:location.hostname,dnt:navigator.doNotTrack=="1"||navigator.globalPrivacyControl?1:0});
fetch(O+"/badge-api/render?"+q,{referrerPolicy:"no-referrer"}).then(function(r){return r.ok?r.json():0}).then(R).catch(N)}
G("consent")=="wait"&&W.VireekBadgeConsent!==!0?W.addEventListener("vireek-badge-consent",go,{once:!0}):go()}();
