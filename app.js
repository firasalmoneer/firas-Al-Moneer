
const DB = window.TAFSIR_DB;

function norm(s){
  if(!s) return "";
  return s.toString()
    .replace(/[ًٌٍَُِّْـ]/g,'')
    .replace(/[إأآ]/g,'ا')
    .replace(/ة/g,'ه')
    .replace(/ى/g,'ي')
    .replace(/[^\u0600-\u06FF\s]/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

const STOP = new Set(norm(`
من في على الى إلى ثم كذلك هذا هذه ذلك تلك الذي التي الذين اللذين انا أنت انت هو هي هم هن نحن كان تكون يكون كانت يكونون مع أو و لا لم لن قد ما ماذا لماذا حيث هنا هناك كما ايضا فقط جدا اكثر اقل كل بعض بين بعد قبل عند عن فإن إن اذا إذ لأن لكن بل حتى اما ثمّ
`).split(' ').filter(Boolean));

const PREFIXES = ["وال","بال","كال","فال","لل","ال","و","ف","ب","ك","ل","س"];
const SUFFIXES = ["كما","كم","كن","هم","هن","نا","ها","ه","ي","ك","ة","ات","ون","ين","ان","ا","ت","ن","و","ى"];

function stem(tok){
  let t = tok;
  for(const p of PREFIXES.sort((a,b)=>b.length-a.length)){
    if(t.startsWith(p) && (t.length - p.length) >= 3){ t = t.slice(p.length); break; }
  }
  for(const s of SUFFIXES.sort((a,b)=>b.length-a.length)){
    if(t.endsWith(s) && (t.length - s.length) >= 3){ t = t.slice(0, -s.length); break; }
  }
  return t;
}

function tokenize(q){
  const t = norm(q);
  if(!t) return [];
  const toks = t.split(' ')
    .filter(x=>x && x.length>=2 && !STOP.has(x))
    .map(stem)
    .filter(x=>x && x.length>=2 && !STOP.has(x));
  return toks;
}

function bm25(queryTokens){
  const idx = DB.index;
  const N = idx.meta.docs;
  const k1 = idx.meta.k1;
  const b = idx.meta.b;
  const avgdl = idx.meta.avgdl;

  const scores = new Map();
  const reasons = new Map();

  function addReason(di, r){
    if(!reasons.has(di)) reasons.set(di, new Set());
    reasons.get(di).add(r);
  }

  // accumulate
  const qt = queryTokens;
  for(const term of qt){
    const postings = idx.inv[term];
    if(!postings) continue;
    const idf = idx.idf[term] ?? 0;
    for(const [di, tf] of postings){
      const dl = idx.doc_len[di] || 0;
      const denom = tf + k1*(1 - b + b*(dl/avgdl));
      const sc = idf * ((tf*(k1+1))/denom);
      scores.set(di, (scores.get(di)||0) + sc);
      addReason(di, `تطابق كلمة: ${term}`);
    }
  }

  // phrase bonus: if query has 2+ tokens, add small bonus when tokens appear close in raw text
  if(qt.length >= 2){
    const rawNeed = qt.slice(0, Math.min(4, qt.length)); // check first few
    for(const di of scores.keys()){
      const raw = norm(DB.docs[di].tafsir_excerpt);
      let ok = 0;
      for(const t of rawNeed){
        if(raw.includes(t)) ok++;
      }
      if(ok >= Math.min(2, rawNeed.length)){
        scores.set(di, scores.get(di) + 0.35*ok);
        addReason(di, "تعزيز: توافق عدة كلمات في نفس المقطع");
      }
    }
  }

  // return ranked
  const arr = Array.from(scores.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 120)
    .map(([di,score])=>({
      di,
      score,
      doc: DB.docs[di],
      reasons: Array.from(reasons.get(di) || [])
    }));
  return arr;
}

function snippet(txt, qTokens){
  const t = txt || "";
  if(!qTokens || !qTokens.length) return t.slice(0, 520) + (t.length>520 ? " …":"");
  const nt = norm(t);
  // find earliest match among tokens
  let idx = -1;
  let term = "";
  for(const tk of qTokens){
    const i = nt.indexOf(tk);
    if(i >= 0 && (idx === -1 || i < idx)){ idx = i; term=tk; }
  }
  if(idx < 0) return t.slice(0, 520) + (t.length>520 ? " …":"");
  const start = Math.max(0, idx - 160);
  const end = Math.min(nt.length, idx + term.length + 240);
  const ratio = t.length / Math.max(1, nt.length);
  const os = Math.floor(start * ratio);
  const oe = Math.min(t.length, Math.floor(end * ratio));
  const s = t.slice(os, oe);
  return s + " …";
}

function el(tag, cls, txt){
  const e = document.createElement(tag);
  if(cls) e.className = cls;
  if(txt !== undefined) e.textContent = txt;
  return e;
}

function renderMeta(){
  const m = DB.meta;
  const box = document.getElementById("metaBox");
  box.innerHTML = "";
  const pills = [
    `المصدر: ${m.source}`,
    `عدد المقاطع: ${m.chunks}`,
    `فهرسة: BM25`,
    `تاريخ البناء: ${m.generated_at}`
  ];
  for(const p of pills){
    box.appendChild(el("div","pill",p));
  }
}

function renderResults(items, qTokens){
  const res = document.getElementById("results");
  const status = document.getElementById("status");
  res.innerHTML = "";

  if(!items.length){
    status.textContent = "لا نتائج. جرّب صياغة أخرى أو كلمة مختلفة.";
    return;
  }
  status.textContent = `عرض ${items.length} نتيجة مرتبة بالصلة.`;

  for(const it of items){
    const d = it.doc;
    const card = el("div","result");
    const top = el("div","rTop");
    const left = el("div");
    const badges = el("div","badges");
    badges.appendChild(el("span","badge ok", `درجة الصلة: ${it.score.toFixed(2)}`));
    badges.appendChild(el("span","badge", `المصدر: ${d.source}`));
    badges.appendChild(el("span","badge", `الموضع: مقطع #${d.location?.chunk_index ?? "؟"}`));
    left.appendChild(badges);

    const btn = el("button","btn","فتح");
    btn.onclick = ()=> openDoc(d);
    top.appendChild(left);
    top.appendChild(btn);

    const sn = el("div","snip", snippet(d.tafsir_excerpt, qTokens));
    const reason = el("div","reason","سبب الظهور: " + (it.reasons.length ? it.reasons.join(" • ") : "—"));

    card.appendChild(top);
    card.appendChild(sn);
    card.appendChild(reason);
    res.appendChild(card);
  }
}

function openDoc(d){
  const card = document.getElementById("openCard");
  card.style.display = "block";
  card.scrollIntoView({behavior:"smooth", block:"start"});
  document.getElementById("openTitle").textContent = "المقطع الكامل";
  document.getElementById("openCite").textContent = `الاستشهاد: ${d.source} — مقطع #${d.location?.chunk_index ?? "؟"}`;
  document.getElementById("openBody").textContent = d.tafsir_excerpt;
}

function search(){
  const q = document.getElementById("q").value.trim();
  const toks = tokenize(q);
  if(!toks.length){
    document.getElementById("status").textContent = "اكتب عبارة فيها كلمات واضحة للبحث.";
    document.getElementById("results").innerHTML = "";
    return;
  }
  const items = bm25(toks);
  renderResults(items, toks);
}

function init(){
  renderMeta();
  document.getElementById("go").onclick = search;
  document.getElementById("q").addEventListener("keydown",(e)=>{
    if(e.key==="Enter") search();
  });
  document.getElementById("clear").onclick = ()=>{
    document.getElementById("q").value="";
    document.getElementById("status").textContent="";
    document.getElementById("results").innerHTML="";
    document.getElementById("openCard").style.display="none";
  };
  document.getElementById("close").onclick = ()=>{ document.getElementById("openCard").style.display="none"; };
}

init();
