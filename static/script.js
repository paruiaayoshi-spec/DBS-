// static/script.js
// Frontend dashboard behaviors (drag/drop, customize modal, save/load layout)
// Works with server-rendered Jinja variables when provided, falls back to localStorage when backend not present.

const DEV_LOCALSTORAGE_KEY = 'jodo_dashboard_layout_v1'

// Panel registry: available panels (id, title, description)
const PANEL_REGISTRY = [
  {id: 'stock_alerts', title: 'Stock Alerts', description: 'Items below threshold'},
  {id: 'transfers', title: 'Transfers', description: 'Pending transfers'},
  {id: 'kpi_strip', title: 'KPIs', description: 'High-level stats'},
  {id: 'recent_activity', title: 'Recent Activity', description: 'Latest actions'},
]

// Default layout: simple list with order
const DEFAULT_LAYOUT = [
  {id: 'kpi_strip', w:12,h:1},
  {id: 'stock_alerts', w:6,h:4},
  {id: 'transfers', w:6,h:4},
  {id: 'recent_activity', w:12,h:3}
]

// track server layout metadata
let serverLayoutMeta = {id: null, version: null}

function readInitialLayout(){
  // Attempt to read server-provided layout JSON from script tag
  const el = document.getElementById('layout-json')
  if(el){
    try{
      const txt = el.textContent.trim()
      if(txt){
        return JSON.parse(txt)
      }
    }catch(e){console.warn('Failed parsing layout-json', e)}
  }
  // Next, try localStorage
  try{
    const raw = localStorage.getItem(DEV_LOCALSTORAGE_KEY)
    if(raw){ return JSON.parse(raw) }
  }catch(e){}
  return DEFAULT_LAYOUT
}

function saveLayoutLocal(layout){
  localStorage.setItem(DEV_LOCALSTORAGE_KEY, JSON.stringify(layout))
}

function renderPanelNode(panel){
  const wrapper = document.createElement('div')
  wrapper.className = 'grid-stack-item'
  wrapper.setAttribute('data-panel-id', panel.id)
  wrapper.setAttribute('tabindex', '0')
  wrapper.setAttribute('role', 'region')
  wrapper.setAttribute('aria-labelledby', `panel-${panel.id}-title`)
  const inner = document.createElement('div')
  inner.className = 'panel'
  inner.innerHTML = `
    <div class="panel-header">
      <div class="panel-title" id="panel-${panel.id}-title">${getPanelTitle(panel.id)}</div>
      <div class="panel-controls">
        <button class="btn secondary btn-move" title="Move" aria-label="Move panel">Move</button>
        <button class="btn secondary btn-settings" title="Settings" aria-label="Panel settings">⚙</button>
        <button class="btn secondary btn-remove" title="Remove" aria-label="Remove panel">✖</button>
      </div>
    </div>
    <div class="panel-body" id="panel-body-${panel.id}">Loading...</div>
  `
  wrapper.appendChild(inner)
  return wrapper
}

function getPanelTitle(id){
  const p = PANEL_REGISTRY.find(x=>x.id===id)
  return p ? p.title : id
}

function renderDashboard(layout){
  const container = document.getElementById('dashboard-grid')
  container.innerHTML = ''
  layout.forEach(p => {
    const node = renderPanelNode(p)
    container.appendChild(node)
    // attempt to load panel data (mocked)
    loadPanelData(p.id).then(html => {
      const body = document.getElementById(`panel-body-${p.id}`)
      if(body) body.innerHTML = html
    })
  })
}

function loadPanelData(panelId){
  // Try fetch to server endpoint; fallback to mocked content
  return new Promise(resolve => {
    fetch(`/api/panels/${panelId}`).then(r=>{
      if(r.ok) return r.json()
      throw new Error('no-api')
    }).then(data=>{
      if(data.html) resolve(data.html)
      else resolve(`<pre>${JSON.stringify(data,null,2)}</pre>`)
    }).catch(()=>{
      // mocked responses
      const mock = {
        stock_alerts: `<ul><li>SKU-1042 — 2 days left</li><li>SKU-2291 — 4 days left</li></ul>`,
        transfers: `<p>2 pending transfers</p>`,
        kpi_strip: `<div style="display:flex;gap:12px"><div class="panel">Total SKUs: 532</div><div class="panel">Alerts: 12</div></div>`,
        recent_activity: `<ol><li>Order SO-1123 created</li><li>Transfer TP-77 ready</li></ol>`
      }
      resolve(mock[panelId] || `<p>No data for ${panelId}</p>`)
    })
  })
}

// utility: read CSRF token from meta tag or cookies (common names)
function getCSRFToken(){
  const meta = document.querySelector('meta[name="csrf-token"]') || document.querySelector('meta[name="csrf_token"]')
  if(meta) return meta.getAttribute('content')
  // check common cookie names
  const cookies = document.cookie.split(';').map(c=>c.trim())
  for(const c of cookies){
    if(c.startsWith('csrf_token=')) return decodeURIComponent(c.split('=')[1])
    if(c.startsWith('XSRF-TOKEN=')) return decodeURIComponent(c.split('=')[1])
  }
  return null
}

// server integration: fetch current layout metadata
async function fetchServerLayout(){
  try{
    const r = await fetch('/api/dashboard/layouts/current')
    if(!r.ok) return null
    const data = await r.json()
    if(data && data.layout_json){
      serverLayoutMeta.id = data.id
      serverLayoutMeta.version = data.version
      return data.layout_json
    }
  }catch(e){
    // ignore
  }
  return null
}

async function saveLayoutToServer(layout){
  const csrf = getCSRFToken()
  const headers = {'Content-Type': 'application/json'}
  if(csrf) headers['X-CSRFToken'] = csrf

  // if we have serverLayoutMeta.id -> update (PUT)
  if(serverLayoutMeta && serverLayoutMeta.id){
    const payload = {layout_json: layout, version: serverLayoutMeta.version}
    const url = `/api/dashboard/layouts/${serverLayoutMeta.id}`
    const r = await fetch(url, {method:'PUT', headers, body: JSON.stringify(payload)})
    if(r.ok){
      const resp = await r.json()
      serverLayoutMeta.version = resp.version
      return {ok:true, savedOn:'server'}
    }
    if(r.status === 409){
      const resp = await r.json()
      // ask user how to resolve
      const accept = window.confirm('Layout changed on server since you last loaded it. Click OK to accept the server version and overwrite local layout, or Cancel to force your layout to server.')
      if(accept){
        // accept server version: replace local and render
        const serverLayout = resp.current_layout || resp.currentLayout || null
        if(serverLayout){
          saveLayoutLocal(serverLayout)
          renderDashboard(serverLayout)
          serverLayoutMeta.version = resp.current_version || resp.currentVersion || serverLayoutMeta.version
          return {ok:true, acceptedServer:true}
        }
        return {ok:false, message:'no_server_layout'}
      }else{
        // force overwrite: set client's version to server's current_version and retry
        const newVersion = resp.current_version || resp.currentVersion
        if(newVersion){
          serverLayoutMeta.version = newVersion
          // retry put
          const retryPayload = {layout_json: layout, version: serverLayoutMeta.version}
          const r2 = await fetch(url, {method:'PUT', headers, body: JSON.stringify(retryPayload)})
          if(r2.ok){
            const resp2 = await r2.json()
            serverLayoutMeta.version = resp2.version
            return {ok:true, forced:true}
          }
        }
        return {ok:false, message:'conflict_not_resolved'}
      }
    }
    // other error
    const err = await r.text()
    return {ok:false, message: err, status: r.status}
  }

  // otherwise create new layout (POST)
  try{
    const payload = {name: 'user-layout', layout_json: layout}
    const r = await fetch('/api/dashboard/layouts', {method:'POST', headers, body: JSON.stringify(payload)})
    if(r.ok){
      const resp = await r.json()
      serverLayoutMeta.id = resp.id
      serverLayoutMeta.version = resp.version
      return {ok:true, savedOn:'server'}
    }
    const txt = await r.text()
    return {ok:false, message: txt, status: r.status}
  }catch(e){
    return {ok:false, message: e.message}
  }
}

// Drag & drop via SortableJS (fallback if not available, enable simple swap)
function enableDragDrop(layout){
  const el = document.getElementById('dashboard-grid')
  if(typeof Sortable !== 'undefined'){
    Sortable.create(el, {
      animation:150,
      onEnd: async ()=>{
        const newLayout = Array.from(el.children).map((child)=>({id: child.getAttribute('data-panel-id')}))
        saveLayoutLocal(newLayout)
        setSaveState('Saved locally')
      }
    })
  }else{
    // basic click-to-swap: not implemented fully. Keep as no-op.
  }
}

function setSaveState(txt){
  const el = document.getElementById('save-state')
  if(el) el.textContent = txt
}

// Customize modal
function openCustomize(){
  const mb = document.getElementById('modal-backdrop')
  mb.style.display = 'flex'
  mb.setAttribute('aria-hidden','false')
  const list = document.getElementById('panel-registry')
  list.innerHTML = ''
  PANEL_REGISTRY.forEach(p=>{
    const card = document.createElement('div')
    card.className = 'panel-card'
    card.innerHTML = `<strong>${p.title}</strong><div class="small">${p.description}</div><div style="margin-top:8px"><button class="btn btn-add" data-panel-id="${p.id}">Add</button></div>`
    list.appendChild(card)
  })
}
function closeCustomize(){
  const mb = document.getElementById('modal-backdrop')
  mb.style.display = 'none'
  mb.setAttribute('aria-hidden','true')
}

function initCustomizeHandlers(){
  document.body.addEventListener('click', async (e)=>{
    if(e.target.matches('.btn-add')){
      const id = e.target.getAttribute('data-panel-id')
      const layout = readInitialLayout()
      // avoid duplicates
      if(!layout.find(x=>x.id===id)){
        layout.push({id:id})
        saveLayoutLocal(layout)
        renderDashboard(layout)
      }
    }
    if(e.target.matches('.btn-remove')){
      const panel = e.target.closest('.grid-stack-item')
      const id = panel.getAttribute('data-panel-id')
      let layout = readInitialLayout()
      layout = layout.filter(x=>x.id!==id)
      saveLayoutLocal(layout)
      renderDashboard(layout)
    }
    if(e.target.matches('#open-customize')) openCustomize()
    if(e.target.matches('#close-customize')) closeCustomize()
    if(e.target.matches('#save-layout')){
      const layout = Array.from(document.getElementById('dashboard-grid').children).map(c=>({id:c.getAttribute('data-panel-id')}))
      saveLayoutLocal(layout)
      setSaveState('Saved locally')
      // attempt to save to server
      try{
        const res = await saveLayoutToServer(layout)
        if(res.ok && res.savedOn==='server') setSaveState('Saved to server')
        else if(res.ok && res.acceptedServer) setSaveState('Accepted server layout')
        else if(res.ok && res.forced) setSaveState('Saved (forced)')
        else if(!res.ok) setSaveState('Saved locally — server save failed')
      }catch(e){
        setSaveState('Saved locally — server save failed')
      }
    }
  })
}

// keyboard accessibility: arrow keys swap panels
function initKeyboardMoves(){
  const grid = document.getElementById('dashboard-grid')
  grid.addEventListener('keydown', (e)=>{
    const target = e.target.closest('.grid-stack-item')
    if(!target) return
    const key = e.key
    if(['ArrowLeft','ArrowRight'].includes(key)){
      e.preventDefault()
      const items = Array.from(grid.children)
      const idx = items.indexOf(target)
      let swapIdx = key==='ArrowLeft' ? idx-1 : idx+1
      if(swapIdx<0 || swapIdx>=items.length) return
      grid.insertBefore(items[swapIdx], items[idx])
      saveLayoutLocal(Array.from(grid.children).map(c=>({id:c.getAttribute('data-panel-id')})))
      setSaveState('Saved locally')
    }
  })
}

// close customize on Escape
function initGlobalKeys(){
  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){
      const mb = document.getElementById('modal-backdrop')
      if(mb && mb.style.display === 'flex') closeCustomize()
    }
  })
}

async function init(){
  // attempt to fetch server layout; if found use it; otherwise fallback
  const serverLayout = await fetchServerLayout()
  const layout = serverLayout || readInitialLayout()
  if(serverLayout){
    // serverLayout likely matches the JSON Schema shape: { panels: [...] }
    // adapt if necessary: if server returns {panels: [...]}, convert to array of panel objects
    if(serverLayout.panels) renderDashboard(serverLayout.panels)
    else renderDashboard(serverLayout)
  }else{
    renderDashboard(layout)
  }
  enableDragDrop(layout)
  initCustomizeHandlers()
  initKeyboardMoves()
  initGlobalKeys()
  setSaveState('Ready')
}

window.addEventListener('DOMContentLoaded', init)
