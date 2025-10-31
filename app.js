const DATA_URL = '/data.json';
const CHECK_INTERVAL_MS = 30000; // 30秒ごと

let seenIds = new Set();

function fmt(ts){
  return new Date(Number(ts)).toLocaleString();
}

function escapeHtml(s){
  if(!s && s !== 0) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function fetchData(){
  try{
    const r = await fetch(DATA_URL + '?_=' + Date.now(), {cache: 'no-store'});
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }catch(e){
    console.warn('fetchData error', e);
    return null;
  }
}

function render(items, updated){
  const list = document.getElementById('list');
  if(!list) return;
  list.innerHTML = '';
  if(!items || items.length === 0){
    list.innerHTML = '<div class="item">現在、表示する情報はありません。</div>';
    return;
  }
  items.forEach(it=>{
    const el = document.createElement('div');
    el.className = 'item';
    const t = it.title || (it.type || '情報');
    const msg = it.message || '';
    const timeStr = fmt(it.time || updated);
    el.innerHTML = `
      <div class="type">${escapeHtml(it.type || '')} ${escapeHtml(t)}</div>
      <div class="time">${escapeHtml(timeStr)}</div>
      <div style="margin-top:6px">${escapeHtml(msg)}</div>
    `;
    list.appendChild(el);
  });
  const meta = document.getElementById('meta');
  if(meta && updated) meta.textContent = '最終更新: ' + fmt(updated);
}

async function notify(title, body){
  if(!('Notification' in window)) return;
  if(Notification.permission === 'granted'){
    new Notification(title, { body });
  } else if(Notification.permission !== 'denied'){
    const p = await Notification.requestPermission();
    if(p === 'granted') new Notification(title, { body });
  }
}

async function checkOnce(){
  const data = await fetchData();
  if(!data) return;
  const items = data.items || [];
  const updated = data.updated || Date.now();
  render(items, updated);

  items.forEach(it=>{
    const id = it.id || (it.type + '|' + (it.time||''));
    if(!seenIds.has(id)){
      const title = (it.title || it.type || '災害情報');
      const body = (it.message && it.message.length > 200) ? it.message.slice(0,200) + '...' : (it.message || '');
      notify(title, body);
      seenIds.add(id);
    }
  });
}

window.addEventListener('load', () => {
  checkOnce();
  setInterval(checkOnce, CHECK_INTERVAL_MS);
});
