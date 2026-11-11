/* inspired x · Mars Guide widget (Mars-only). Talks to the chatbot server (chatbot/, port 3000).
   The AI key lives only in chatbot/.env on the server; nothing secret is in this file.
   Pages may define:  window.marsContext = () => string   window.CHAT_POS = {left:20,bottom:96} | {left:12,top:100}
                      window.CHAT_NODE = "http://localhost:3000" (default: same host, port 3000) */
(() => {
  const NODE = window.CHAT_NODE || (location.protocol === 'file:' ? '' : `${location.protocol}//${location.hostname}:3000`);
  const pos = Object.assign({ left: 20, bottom: 20 }, window.CHAT_POS || {});
  const place = Object.entries(pos).map(([k, v]) => `${k}:${v}px`).join(';');
  const css = `
#chat{position:fixed;z-index:1500;${place};font-family:"Tajawal",system-ui,sans-serif;direction:rtl}
#cfab{width:54px;height:54px;border-radius:50%;border:1px solid #ffffff33;cursor:pointer;color:#fff;font-size:24px;background:linear-gradient(135deg,#ff6a3d,#8b5cf6);box-shadow:0 8px 30px #ff6a3d55;transition:transform .2s}
#cfab:hover{transform:scale(1.08)}
#cbox{position:absolute;${pos.top !== undefined ? 'top:64px' : 'bottom:64px'};left:0;width:min(410px,calc(100vw - 24px));height:min(580px,74vh);display:flex;flex-direction:column;background:#0f0b1bf5;border:1px solid #ffffff2a;border-radius:16px;box-shadow:0 20px 70px #000c;overflow:hidden}
#cbox[hidden]{display:none}
#chd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ffffff1c}
#chd b{font:800 13px Orbitron,Tajawal,sans-serif;color:#fff;letter-spacing:.04em}#chd b i{font-style:normal;color:#6fe3ff}
#cmodel{margin-inline-start:auto;font-size:11px;color:#a597b8;direction:ltr}
#cx{background:none;border:0;color:#a597b8;font-size:18px;cursor:pointer}
#cmsgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin}
.cm{max-width:92%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#f2ecff}
.cm.user{align-self:flex-start;background:#ff6a3d33;border:1px solid #ff6a3d55}.cm.bot{align-self:flex-end;background:#ffffff0f;border:1px solid #ffffff1c}.cm.err{color:#ff9a80;border-color:#ef535088}
.cm.sys{align-self:center;font-size:12px;color:#a597b8;background:none;border:0;text-align:center}
.cc{white-space:normal;margin-top:8px;padding:8px;border:1px solid #ffffff22;border-radius:10px;background:#0006;direction:ltr;text-align:left}
.cc h4{margin:0 0 6px;font-size:13px;color:#ffb86b}.cc small{display:block;color:#a597b8;font-size:11px}.cc a{color:#6fe3ff;font-size:12px}
.cc .g{display:grid;grid-template-columns:1fr 1fr;gap:6px}.cc .g img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block}
#csug{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 8px}#csug button{font:inherit;font-size:12px;color:#f2ecff;background:#ffffff10;border:1px solid #ffffff22;border-radius:99px;padding:4px 10px;cursor:pointer}
#cfm{display:flex;gap:6px;padding:10px;border-top:1px solid #ffffff1c}
#cin{flex:1;resize:none;height:42px;background:#ffffff0d;color:#f2ecff;border:1px solid #ffffff22;border-radius:10px;padding:8px 10px;font:inherit;font-size:14px}
#csend{border:0;border-radius:10px;padding:0 14px;cursor:pointer;color:#1a0a05;font-weight:700;background:linear-gradient(135deg,#ff6a3d,#ff9a3d)}
#cnote{font-size:10px;color:#a597b8;text-align:center;padding:0 10px 8px}`;
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
  const root = document.createElement('div');
  root.id = 'chat';
  root.innerHTML = `<button id="cfab" aria-label="مساعد المريخ">💬</button>
<section id="cbox" hidden aria-label="مساعد المريخ">
 <div id="chd"><b>inspired<i>x</i> · MARS GUIDE</b><span id="cmodel"></span><button id="cx" aria-label="إغلاق">✕</button></div>
 <div id="cmsgs"></div><div id="csug"></div>
 <form id="cfm"><textarea id="cin" placeholder="اسأل عن المريخ فقط…" rows="1" maxlength="1000"></textarea><button id="csend" type="submit">إرسال</button></form>
 <div id="cnote">مساعد متخصص في المريخ فقط. قد يخطئ؛ الأرقام الموثّقة هي التي في لوحات الموقع وبطاقات ناسا.</div>
</section>`;
  document.body.appendChild(root);
  const $ = s => root.querySelector(s), box = $('#cbox'), msgs = $('#cmsgs'), inp = $('#cin');
  const hist = []; let ctl = null, ready = false;
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const add = (cls, text) => { const d = el('div', 'cm ' + cls, text); d.dir = 'auto'; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
  const http = u => /^https?:\/\//.test(u || '') ? u : '';
  const ctx = () => (window.marsContext && window.marsContext()) || '';

  function gallery(parent, d) {          // NASA Image and Video Library cards
    if (!d || d.type !== 'gallery' || !d.items.length) return;
    const c = el('div', 'cc'); c.appendChild(el('h4', 0, d.title));
    const g = el('div', 'g');
    d.items.forEach(it => { const w = el('div'), a = el('a'); if (http(it.nasaUrl)) { a.href = it.nasaUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      const i = el('img'); i.src = http(it.image); i.alt = it.title || ''; i.loading = 'lazy'; a.appendChild(i); w.append(a, el('small', 0, (it.title || '').slice(0, 70))); g.appendChild(w); });
    c.appendChild(g); parent.appendChild(c);
  }

  async function status() {
    try {
      const j = await (await fetch(NODE + '/api/health', { signal: AbortSignal.timeout(2500) })).json();
      ready = !!j.ok; $('#cmodel').textContent = j.model ? `${j.aiProvider} · ${j.model}` : '';
      add('sys', j.ok ? 'أهلاً! أنا مساعد المريخ. اسألني عن الكوكب والمهمات وما تراه على الخريطة.' : '⚠ ' + (j.error || 'المساعد غير جاهز'));
    } catch (e) { add('sys', '⚠ خادم الشات غير شغّال. شغّل run_all.bat ثم افتح الموقع من localhost:8000.'); }
  }
  ['ليه فوهة جيزيرو مهمة؟', 'وريني صور Curiosity', 'يعني إيه انحدار خطر للهبوط؟'].forEach(t => { const b = el('button', 0, t); b.type = 'button'; b.onclick = () => { inp.value = t; $('#cfm').requestSubmit(); }; $('#csug').appendChild(b); });

  async function send(text) {
    hist.push({ role: 'user', content: text }); add('user', text); $('#csug').style.display = 'none';
    const b = add('bot', '…'); ctl = new AbortController(); $('#csend').textContent = 'إيقاف';
    try {
      const r = await fetch(NODE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ message: text, history: hist.slice(-13, -1), context: ctx() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      const out = (j.text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim() || 'لم أتمكن من إنشاء رد.';
      b.textContent = out; gallery(b, j.science); msgs.scrollTop = msgs.scrollHeight;
      hist.push({ role: 'assistant', content: out });
    } catch (e) {
      if (e.name === 'AbortError') { b.textContent = '⏹'; hist.pop(); }
      else { b.textContent = '⚠ ' + (e.message === 'Failed to fetch' ? 'تعذّر الوصول إلى خادم الشات. هل run_all.bat شغّال؟' : e.message); b.classList.add('err'); hist.pop(); ready = false; }
    }
    ctl = null; $('#csend').textContent = 'إرسال';
  }
  $('#cfm').onsubmit = e => { e.preventDefault(); if (ctl) { ctl.abort(); return; } const t = inp.value.trim(); if (!t) return; inp.value = ''; send(t); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#cfm').requestSubmit(); } });
  $('#cfab').onclick = () => { box.hidden = !box.hidden; if (!box.hidden) { inp.focus(); if (!msgs.children.length) status(); } };
  $('#cx').onclick = () => box.hidden = true;
})();
