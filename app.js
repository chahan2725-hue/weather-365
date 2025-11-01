/* app.js
  - 目的: index.html に表示するためのクライアント側JS
  - 機能:
    ・地震(最新5件)、EEW、火山、気象警報（代表）、土砂災害 等の"種類ごと"カード
    ・メール版/既存データは data.json をフォールバックで利用
    ・カードは折りたたみ（details）で本文表示、コピーボタンあり
    ・自動更新30秒（手動再読み込みボタンあり）
    ・新着があれば通知（localStorageに既通知キーを保存）
*/

(() => {
  // --- 設定 ---
  const UPDATE_INTERVAL_MS = 30000; // 30秒
  const cardsContainer = document.getElementById('cardsContainer');
  const refreshBtn = document.getElementById('refreshBtn');
  const toggleAutoBtn = document.getElementById('toggleAutoBtn');

  // API エンドポイント（必要に応じて変更）
  const ENDPOINTS = {
    earthquakes: "https://api.p2pquake.net/v2/history?codes=551&limit=5",
    eew: "https://api.wolfx.jp/jma_eew.json", // EEW（フォールダミー）
    // 以下は代表例。気象庁のXML等を直接引く場合は CORS に注意。
    // ここでは data.json フォールバックで対応する想定。
    volcano: null,
    weatherWarnings: null,
    landslide: null
  };

  // --- 通知・既通知キー管理 ---
  let autoUpdate = true;
  let timerId = null;

  // localStorage に保存するキー
  const STORAGE_KEYS = {
    seenItems: 'disaster_seen_keys_v1' // オブジェクト: { earthquakes: [key1,...], eew: key, ... }
  };

  // 初期化済みの既通知オブジェクト
  function loadSeen() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.seenItems);
      return raw ? JSON.parse(raw) : { earthquakes: [], eew: null, volcano: null, weatherWarnings: null, landslide: null };
    } catch (e) {
      return { earthquakes: [], eew: null, volcano: null, weatherWarnings: null, landslide: null };
    }
  }
  function saveSeen(obj) { localStorage.setItem(STORAGE_KEYS.seenItems, JSON.stringify(obj)); }
  let seen = loadSeen();

  // Notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(()=>{/* ignore */});
  }

  // --- ユーティリティ ---
  function formatDateISO(t) {
    try {
      return new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    } catch (e) {
      return String(t);
    }
  }
  function copyToClipboard(text) {
    if (!navigator.clipboard) {
      alert('コピー非対応のブラウザです');
      return;
    }
    navigator.clipboard.writeText(text).then(()=> {
      // 軽い UX
      const prev = document.activeElement;
      alert('コピーしました');
      if (prev) prev.focus();
    }).catch(()=> alert('コピーに失敗しました'));
  }
  function notifyIfAllowed(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification(title, { body: body });
    } catch (e) {
      // ignore
    }
  }
  function safeTextFromHTML(html) {
    // 貼り付け用にタグを落として整形
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  }

  // 比較関数（震度の並び）
  function compareScale(a,b){ const order={'1':10,'2':20,'3':30,'4':40,'5-':45,'5+':50,'6-':55,'6+':60,'7':70}; return (order[a]||0)-(order[b]||0); }
  function scaleToText(scale){
    const map={10:'1',20:'2',30:'3',40:'4',45:'5-',50:'5+',55:'6-',60:'6+',70:'7'};
    return map[scale]||'不明';
  }
  function scaleClass(scale){
    if(!scale) return '';
    return `scale-${String(scale).replace('+','plus').replace('-','minus')}`;
  }

  // --- data.json フォールバック読み込み ---
  async function loadDataJson() {
    try {
      const res = await fetch('data.json', { cache: "no-store" });
      if (!res.ok) throw new Error('no data.json');
      return await res.json();
    } catch (e) {
      return {}; // 空のオブジェクト（フォールバックなし）
    }
  }

  // --- カード作成ヘルパー ---
  function makeCard(idKey, iconHtml, mainTitle, subTitle, bodyHtml, shortTextForCopy) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <div class="icon">${iconHtml}</div>
        <div class="meta">
          <div class="title">${mainTitle}</div>
          <div class="sub">${subTitle || ''}</div>
        </div>
        <div class="actions">
          <button class="copyBtn" title="本文をコピー"><i class="fa-solid fa-copy"></i></button>
          <button class="toggleBtn" title="開く/閉じる"><i class="fa-solid fa-chevron-down"></i></button>
        </div>
      </div>
      <details style="margin-top:8px">
        <summary>本文を表示 ▼</summary>
        <div class="body-text">${bodyHtml}</div>
      </details>
    `;
    // copy 挙動
    const copyBtn = card.querySelector('.copyBtn');
    copyBtn.addEventListener('click', () => {
      const details = card.querySelector('details');
      // prefer copying the displayed body (HTML->text) or fallback to provided text
      const bodyNode = card.querySelector('.body-text');
      const text = bodyNode ? safeTextFromHTML(bodyNode.innerHTML) : (shortTextForCopy || '');
      copyToClipboard(text);
    });

    // toggle button (open/close details)
    const toggleBtn = card.querySelector('.toggleBtn');
    toggleBtn.addEventListener('click', () => {
      const details = card.querySelector('details');
      if (!details) return;
      details.open = !details.open;
      toggleBtn.innerHTML = details.open ? '<i class="fa-solid fa-chevron-up"></i>' : '<i class="fa-solid fa-chevron-down"></i>';
    });

    card.id = idKey;
    return card;
  }

  // --- 各種フェッチ & レンダー関数 ---
  // 1) 地震（最新5件 + 各地の震度） - p2pquake
  async function fetchAndRenderEarthquakes(fallback) {
    // fallback: data.json.earthquakes maybe present
    let items = null;
    try {
      const res = await fetch(ENDPOINTS.earthquakes, { cache: "no-store" });
      if (res.ok) items = await res.json();
    } catch (e) { /* ignore */ }
    if (!items && fallback && fallback.earthquakes) items = fallback.earthquakes;

    // render
    // Remove old card if exists
    const idKey = 'card-earthquakes';
    const existing = document.getElementById(idKey);
    if (existing) existing.remove();

    if (!items || items.length === 0) {
      const card = makeCard(idKey, '<i class="fa-solid fa-earthquake"></i>', '地震情報（最新）', 'データなし', '<div class="small">地震情報が見つかりません。</div>', '');
      cardsContainer.prepend(card);
      return;
    }

    // Build body HTML combining up to 5 items (using your mail-style)
    let bodyHtml = '';
    let newKeys = [];
    items.slice(0,5).forEach(item => {
      const eq = item.earthquake || item;
      const h = eq.hypocenter || {};
      const time = formatDateISO(eq.time || item.time || '');
      const place = (h.name || h.place || item.hypocenter?.name) || '(発生地点不明)';
      const maxScale = scaleToText(eq.maxScale);
      const magnitude = (h.magnitude != null && h.magnitude >= 0) ? (h.magnitude.toFixed ? h.magnitude.toFixed(1) : String(h.magnitude)) : (item.magnitude || '不明');
      const depth = (h.depth != null) ? (h.depth === 0 ? 'ごく浅い' : (h.depth + 'km')) : (item.depth || '不明');

      // build各地震の各地の震度テキスト
      let areaText = '';
      if (item.points && Array.isArray(item.points) && item.points.length > 0) {
        // compute cityMaxScale then grouped by scale
        const cityMaxScale = {};
        item.points.forEach(p => {
          const scale = scaleToText(p.scale);
          const cityMatch = (p.addr || '').match(/(.+?[市区町村])/);
          const city = cityMatch ? cityMatch[1] : (p.addr || '');
          const key = `${p.pref || ''}:${city}`;
          if (!cityMaxScale[key] || compareScale(scale, cityMaxScale[key]) > 0) cityMaxScale[key] = scale;
        });
        const grouped = {};
        Object.keys(cityMaxScale).forEach(k => {
          const [pref, city] = k.split(':');
          const scale = cityMaxScale[k];
          if (!grouped[scale]) grouped[scale] = {};
          if (!grouped[scale][pref]) grouped[scale][pref] = [];
          grouped[scale][pref].push(city);
        });
        // sort scales by severity desc
        Object.keys(grouped).sort((a,b) => compareScale(b,a)).forEach(scale => {
          areaText += `<div>◁震度${scale}▷</div>`;
          Object.keys(grouped[scale]).forEach(pref => {
            areaText += `<div>［${pref}］${grouped[scale][pref].sort().join('、')}</div>`;
          });
        });
      } else if (item.intensity) {
        areaText = `<div>${item.intensity}</div>`;
      }

      const tsunami = (eq.domesticTsunami === "Warning" || eq.domesticTsunami === "Watch") ? '津波に関する情報を発表しています。' : 'この地震による津波の心配はありません。';
      // mail-like block
      bodyHtml += `<div style="margin-bottom:12px;padding-bottom:8px;border-bottom:1px dashed #eee;">
《地震情報》
${time}
震源地　${place}
最大震度　${maxScale}
マグニチュード　${magnitude}
深さ　${depth}
${tsunami}
${ areaText ? '<div style="margin-top:6px;">◆各地の震度◆</div>' + areaText : '' }
</div>`;

      // unique key for detection: use item.id + issue.type if present
      const key = (item.id ? item.id : (eq.id || '')) + '_' + (item.issue?.type || eq.issue?.type || '');
      newKeys.push(key);
    });

    // short text for copy
    const shortText = safeTextFromHTML(bodyHtml);

    const card = makeCard(idKey, '<i class="fa-solid fa-earthquake"></i>', '地震情報（最新5件）', '更新: ' + formatDateISO(new Date()), bodyHtml, shortText);
    // prepend so topmost
    cardsContainer.prepend(card);

    // notification logic: if any new key not in seen.earthquakes -> notify and store
    const prevList = seen.earthquakes || [];
    const added = newKeys.filter(k => !prevList.includes(k));
    if (added.length > 0) {
      // simple notify with first new
      const sample = items[0];
      const placeSample = sample?.earthquake?.hypocenter?.name || sample?.earthquake?.hypocenter?.place || '不明';
      const maxScaleSample = scaleToText(sample?.earthquake?.maxScale);
      notifyIfAllowed('新しい地震情報', `${placeSample} 最大震度:${maxScaleSample}`);
      // update seen: keep only latest 10 keys
      const merged = [...added, ...prevList].slice(0, 10);
      seen.earthquakes = merged;
      saveSeen(seen);
    }
  }

  // 2) EEW（緊急地震速報） - jma_eew-ish
  async function fetchAndRenderEEW(fallback) {
    let data = null;
    try {
      const res = await fetch(ENDPOINTS.eew, { cache: "no-store" });
      if (res.ok) data = await res.json();
    } catch (e) { /* ignore */ }
    if (!data && fallback && fallback.eew) data = fallback.eew;

    const idKey = 'card-eew';
    const existing = document.getElementById(idKey);
    if (existing) existing.remove();

    if (!data || Object.keys(data).length === 0) {
      const card = makeCard(idKey, '<i class="fa-solid fa-bolt"></i>', '緊急地震速報（EEW）', 'データなし', '<div class="small">EEW情報が見つかりません。</div>', '');
      cardsContainer.prepend(card);
      return;
    }

    if (data.isTraining) {
      const card = makeCard(idKey, '<i class="fa-solid fa-bolt"></i>', '緊急地震速報（訓練）', '', '<div class="small">訓練報のため表示しません。</div>', '');
      cardsContainer.prepend(card);
      return;
    }
    if (data.isCancel) {
      const card = makeCard(idKey, '<i class="fa-solid fa-bolt"></i>', '緊急地震速報（取消）', '', '<div class="small">このEEWはキャンセルされました。</div>', '');
      cardsContainer.prepend(card);
      return;
    }

    // Build mail-like text from provided example
    const isFinal = data.isFinal;
    const serialText = isFinal ? '最終報' : (data.Serial ? `第${data.Serial}報` : '');
    const origin = data.OriginTime ? formatDateISO(data.OriginTime) : (data.origin || '発生時刻不明');
    const hypocenter = data.Hypocenter || data.hypocenter || '震源地不明';
    const magnitude = data.Magunitude || data.Mag || '不明';
    const depth = data.Depth || '不明';
    const maxInt = data.MaxIntensity || data.maxInt || '不明';
    let areaText = '';
    if (Array.isArray(data.WarnArea) && data.WarnArea.length > 0) {
      areaText = data.WarnArea.map(a => a.Chiiki || a.chiiki || a.name || '').join('、');
      areaText = `対象地域: ${areaText}`;
    } else if (data.warnAreaText) {
      areaText = data.warnAreaText;
    }

    const bodyHtml = `<div style="margin-bottom:6px;">
◆緊急地震速報（予報）◆<br>
＊${serialText || ''}<br><br>
発生時刻: ${origin}<br>
${hypocenter} で地震が発生した模様です。<br>
推定最大震度は ${maxInt} で、マグニチュードは${magnitude}、震源の深さは${depth}kmと推定されます。<br>
${areaText ? areaText + '<br>' : '' }
今後の情報に注意してください。
</div>`;

    const shortText = safeTextFromHTML(bodyHtml);
    const card = makeCard(idKey, '<i class="fa-solid fa-bolt"></i>', '緊急地震速報（EEW）', serialText ? serialText : '最新', bodyHtml, shortText);
    cardsContainer.prepend(card);

    // notification: use EventID+Serial (or fallback)
    const key = (data.EventID ? data.EventID : '') + '_' + (data.Serial ? data.Serial : '');
    if (key && seen.eew !== key) {
      notifyIfAllowed('緊急地震速報(EEW)', `${hypocenter} 最大震度:${maxInt}`);
      seen.eew = key;
      saveSeen(seen);
    }
  }

  // 3) 火山情報（メール版がある場合は data.json から）
  async function fetchAndRenderVolcano(fallback) {
    // We'll primarily rely on fallback data.json.volcano if endpoint not configured
    const idKey = 'card-volcano';
    const existing = document.getElementById(idKey); if (existing) existing.remove();

    let volcanoData = null;
    if (fallback && fallback.volcano) volcanoData = fallback.volcano;

    if (!volcanoData) {
      const card = makeCard(idKey, '<i class="fa-solid fa-mountain"></i>', '噴火情報（火山）', '', '<div class="small">火山情報なし</div>', '');
      cardsContainer.appendChild(card);
      return;
    }

    // Suppose volcanoData is an array of messages
    let bodyHtml = '';
    volcanoData.forEach(v => {
      const time = v.time || new Date();
      bodyHtml += `<div style="margin-bottom:8px;">${v.title || '噴火情報'}<br>${v.text || v.body || ''}</div>`;
    });

    const card = makeCard(idKey, '<i class="fa-solid fa-mountain"></i>', '噴火情報（火山）', '', bodyHtml, safeTextFromHTML(bodyHtml));
    cardsContainer.appendChild(card);
  }

  // 4) 代表的な気象警報（気象庁の注意報・警報等。data.json に任せる）
  async function fetchAndRenderWeatherWarnings(fallback) {
    const idKey = 'card-weather';
    const existing = document.getElementById(idKey); if (existing) existing.remove();

    let data = null;
    if (fallback && fallback.weatherWarnings) data = fallback.weatherWarnings;

    if (!data) {
      const card = makeCard(idKey, '<i class="fa-solid fa-cloud-showers-heavy"></i>', '気象警報・注意報', '', '<div class="small">気象警報・注意報の情報がありません。</div>', '');
      cardsContainer.appendChild(card);
      return;
    }

    // assume data is an array of messages
    let bodyHtml = '';
    data.forEach(item => {
      bodyHtml += `<div style="margin-bottom:8px;">${item.title || ''}<br>${item.text || item.body || ''}</div>`;
    });

    const card = makeCard(idKey, '<i class="fa-solid fa-cloud-showers-heavy"></i>', '気象警報・注意報', '', bodyHtml, safeTextFromHTML(bodyHtml));
    cardsContainer.appendChild(card);
  }

  // 5) 土砂災害等（同様に data.json を利用）
  async function fetchAndRenderLandslide(fallback) {
    const idKey = 'card-landslide';
    const existing = document.getElementById(idKey); if (existing) existing.remove();

    let data = null;
    if (fallback && fallback.landslide) data = fallback.landslide;

    if (!data) {
      const card = makeCard(idKey, '<i class="fa-solid fa-water"></i>', '土砂災害警戒情報', '', '<div class="small">土砂災害警戒情報はありません。</div>', '');
      cardsContainer.appendChild(card);
      return;
    }

    let bodyHtml = '';
    data.forEach(item => {
      bodyHtml += `<div style="margin-bottom:8px;">${item.title || ''}<br>${item.text || item.body || ''}</div>`;
    });

    const card = makeCard(idKey, '<i class="fa-solid fa-water"></i>', '土砂災害警戒情報', '', bodyHtml, safeTextFromHTML(bodyHtml));
    cardsContainer.appendChild(card);
  }

  // --- 全体フロー（fetch all and render） ---
  async function updateAll() {
    // load fallback data.json once per run
    const fallback = await loadDataJson();

    // call each renderer (order: EEW, Earthquake, Volcano, Weather, Landslide) — EEW first to surface
    try { await fetchAndRenderEEW(fallback); } catch (e) { console.error('EEW render error', e); }
    try { await fetchAndRenderEarthquakes(fallback); } catch (e) { console.error('EQ render error', e); }
    try { await fetchAndRenderVolcano(fallback); } catch (e) { console.error('Volcano render error', e); }
    try { await fetchAndRenderWeatherWarnings(fallback); } catch (e) { console.error('Weather render error', e); }
    try { await fetchAndRenderLandslide(fallback); } catch (e) { console.error('Landslide render error', e); }
  }

  // --- 自動更新管理 ---
  async function startAuto() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      if (autoUpdate) updateAll();
    }, UPDATE_INTERVAL_MS);
  }

  // Buttons
  refreshBtn.addEventListener('click', () => {
    updateAll();
  });
  toggleAutoBtn.addEventListener('click', () => {
    autoUpdate = !autoUpdate;
    toggleAutoBtn.textContent = `自動更新: ${autoUpdate ? 'ON' : 'OFF'}`;
    if (!autoUpdate && timerId) {
      // keep the interval but skip when autoUpdate=false; or clear interval to save CPU
      clearInterval(timerId); timerId = null;
    } else if (autoUpdate && !timerId) {
      startAuto();
    }
  });

  // initial run
  updateAll();
  startAuto();

  // expose for debug (optional)
  window.__disaster_updateAll = updateAll;
})();
