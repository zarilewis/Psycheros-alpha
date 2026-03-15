/**
 * Knowledge Graph Visualization
 *
 * Interactive visualization of the knowledge graph using vis-network.
 * Integrated with the Psycheros design system (tokens.css + components.css).
 */

// Node type configuration — uses accent-derived palette
// Colors are generated at render time from CSS variables
function getNodeTypeConfig() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || '#39ff14';

  return {
    self:       { hue: 160, label: 'Self' },
    person:     { hue: 200, label: 'Person' },
    emotion:    { hue: 340, label: 'Emotion' },
    event:      { hue: 220, label: 'Event' },
    memory_ref: { hue: 280, label: 'Memory' },
    topic:      { hue: 35,  label: 'Topic' },
    preference: { hue: 180, label: 'Preference' },
    place:      { hue: 25,  label: 'Place' },
    goal:       { hue: 55,  label: 'Goal' },
    health:     { hue: 0,   label: 'Health' },
    boundary:   { hue: 210, label: 'Boundary' },
    tradition:  { hue: 90,  label: 'Tradition' },
    insight:    { hue: 45,  label: 'Insight' },
    default:    { hue: 0,   label: 'Other' }
  };
}

function hslColor(hue, s, l, a) {
  if (a !== undefined) return `hsla(${hue}, ${s}%, ${l}%, ${a})`;
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

function getNodeColor(type) {
  const config = getNodeTypeConfig();
  const info = config[type] || config.default;
  return {
    background: hslColor(info.hue, 55, 35),
    border: hslColor(info.hue, 55, 50),
    highlight: {
      background: hslColor(info.hue, 60, 45),
      border: hslColor(info.hue, 70, 60)
    },
    hover: {
      background: hslColor(info.hue, 55, 40),
      border: hslColor(info.hue, 60, 55)
    }
  };
}

// Edge styling — muted tones that don't compete with nodes
function getEdgeColor(type) {
  const map = {
    feels_about:  { h: 340, s: 40 },
    comforted_by: { h: 140, s: 40 },
    stressed_by:  { h: 0,   s: 50 },
    close_to:     { h: 210, s: 40 },
    mentions:     { h: 270, s: 30 },
    loves:        { h: 340, s: 50 },
    dislikes:     { h: 25,  s: 40 },
    helps_with:   { h: 140, s: 40 },
    worsens:      { h: 0,   s: 50 },
    includes:     { h: 200, s: 30 },
    family_of:    { h: 30,  s: 40 },
    friend_of:    { h: 200, s: 40 },
    seeks:        { h: 55,  s: 40 },
    avoids:       { h: 0,   s: 30 },
    reminds_of:   { h: 270, s: 30 }
  };
  const info = map[type] || { h: 0, s: 0 };
  const color = hslColor(info.h, info.s, 45, 0.7);
  return { color, highlight: hslColor(info.h, info.s + 10, 55), hover: color };
}

// ─── State ───────────────────────────────────────────────────────────────────

let network = null;
let graphData = { nodes: [], edges: [] };
let selectedNodes = [];
let initialized = false;

// ─── Initialization ──────────────────────────────────────────────────────────

async function initGraph() {
  if (initialized) return;
  initialized = true;
  await loadGraphData();
  setupEventListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraph);
} else {
  initGraph();
}

document.body.addEventListener('htmx:afterSwap', (e) => {
  if (e.detail.target?.id === 'chat' && document.getElementById('graph-container')) {
    initGraph();
  }
});

globalThis.initGraphView = initGraph;

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadGraphData() {
  const container = document.getElementById('graph-container');
  if (!container) return;

  try {
    const response = await fetch('/api/graph');
    if (!response.ok) throw new Error('Failed to load graph data');

    graphData = await response.json();

    if (!graphData.nodes || graphData.nodes.length === 0) {
      container.innerHTML = `
        <div class="gv-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
            <circle cx="12" cy="12" r="3"/>
            <circle cx="5" cy="6" r="2"/>
            <circle cx="19" cy="6" r="2"/>
            <circle cx="5" cy="18" r="2"/>
            <circle cx="19" cy="18" r="2"/>
            <line x1="7" y1="7" x2="10" y2="10"/>
            <line x1="17" y1="7" x2="14" y2="10"/>
            <line x1="7" y1="17" x2="10" y2="14"/>
            <line x1="17" y1="17" x2="14" y2="14"/>
          </svg>
          <p>Knowledge graph is empty</p>
          <p class="gv-empty-hint">Create nodes during conversation or use the + button below</p>
        </div>
      `;
      return;
    }

    renderGraph();
    populateTypeFilter();
  } catch (error) {
    container.innerHTML = `
      <div class="gv-empty">
        <p>Failed to load graph data</p>
        <p class="gv-empty-hint">${error.message}</p>
        <button onclick="loadGraphData()" class="btn btn--ghost" style="margin-top: var(--sp-3)">Retry</button>
      </div>
    `;
  }
}

// ─── Graph Rendering ─────────────────────────────────────────────────────────

function renderGraph() {
  const container = document.getElementById('graph-container');
  container.innerHTML = '';

  const nodes = new vis.DataSet(
    graphData.nodes.map(node => {
      const colors = getNodeColor(node.type);
      return {
        id: node.id,
        label: node.label.length > 20 ? node.label.substring(0, 17) + '...' : node.label,
        title: `${node.type}: ${node.label}\n${node.description || ''}\nConfidence: ${Math.round(node.confidence * 100)}%`,
        color: colors,
        borderWidth: 2,
        borderWidthSelected: 3,
        font: { color: '#e8e8e8', size: 13, face: 'IBM Plex Sans, Inter, sans-serif' },
        shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 8, x: 0, y: 2 },
        data: node
      };
    })
  );

  const edges = new vis.DataSet(
    graphData.edges.map(edge => {
      const colors = getEdgeColor(edge.type);
      return {
        id: edge.id,
        from: edge.fromId,
        to: edge.toId,
        label: edge.customType || edge.type,
        title: `${edge.type}\nWeight: ${Math.round(edge.weight * 100)}%`,
        color: colors,
        width: 1 + edge.weight * 1.5,
        font: { size: 9, color: 'rgba(232,232,232,0.5)', strokeWidth: 0, face: 'IBM Plex Mono, monospace' },
        smooth: { type: 'curvedCW', roundness: 0.15 },
        data: edge
      };
    })
  );

  const options = {
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -2500,
        centralGravity: 0.25,
        springLength: 160,
        springConstant: 0.04,
        damping: 0.12
      },
      stabilization: { iterations: 150, fit: true }
    },
    interaction: {
      hover: true,
      tooltipDelay: 300,
      zoomView: true,
      dragView: true,
      multiselect: true,
      navigationButtons: false,
      keyboard: false
    },
    nodes: {
      shape: 'dot',
      size: 18,
      scaling: { min: 12, max: 28 }
    },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      smooth: { enabled: true, type: 'continuous' }
    }
  };

  network = new vis.Network(container, { nodes, edges }, options);

  network.on('click', handleNetworkClick);
  network.on('doubleClick', handleNetworkDoubleClick);
  // Disable physics once the layout has settled — prevents fight with focus/drag
  network.on('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  });
}

// ─── Interaction Handlers ────────────────────────────────────────────────────

function handleNetworkClick(params) {
  selectedNodes = network.getSelectedNodes() || [];
  updateButtonStates();

  if (params.nodes && params.nodes.length === 1) {
    showNodePanel(params.nodes[0]);
  } else {
    hideNodePanel();
  }
}

function handleNetworkDoubleClick(params) {
  if (params.nodes && params.nodes.length === 1) {
    network.focus(params.nodes[0], { animation: true, scale: 1.5 });
  }
}

function showNodePanel(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const panel = document.getElementById('graph-node-panel');
  const label = document.getElementById('panel-node-label');
  const content = document.getElementById('panel-content');

  const connectedEdges = graphData.edges.filter(e =>
    e.fromId === nodeId || e.toId === nodeId
  );

  const typeConfig = getNodeTypeConfig();
  const typeInfo = typeConfig[node.type] || typeConfig.default;
  const typeColor = hslColor(typeInfo.hue, 55, 50);

  const connections = connectedEdges.map(edge => {
    const isFrom = edge.fromId === nodeId;
    const otherNodeId = isFrom ? edge.toId : edge.fromId;
    const otherNode = graphData.nodes.find(n => n.id === otherNodeId);
    const dir = isFrom ? '&rarr;' : '&larr;';
    return `<li><span class="gv-conn-dir">${dir}</span> <span class="gv-conn-type">${edge.customType || edge.type}</span> <span class="gv-conn-label">${otherNode?.label || '?'}</span></li>`;
  }).join('');

  label.textContent = node.label;
  content.innerHTML = `
    <div class="gv-detail-row">
      <span class="gv-detail-label">Type</span>
      <span class="gv-detail-value" style="color: ${typeColor}">${node.type}</span>
    </div>
    <div class="gv-detail-row">
      <span class="gv-detail-label">Confidence</span>
      <span class="gv-detail-value">${Math.round(node.confidence * 100)}%</span>
    </div>
    ${node.description ? `
      <div class="gv-detail-section">
        <div class="gv-detail-label">Description</div>
        <p class="gv-detail-desc">${node.description}</p>
      </div>
    ` : ''}
    ${connections ? `
      <div class="gv-detail-section">
        <div class="gv-detail-label">Connections (${connectedEdges.length})</div>
        <ul class="gv-conn-list">${connections}</ul>
      </div>
    ` : ''}
    <div class="gv-detail-section">
      <div class="gv-detail-label">ID</div>
      <code class="gv-node-id">${node.id}</code>
    </div>
    <button class="btn btn--ghost gv-edit-btn" onclick="openEditModal('${node.id}')">Edit Node</button>
  `;

  panel.classList.add('gv-panel-open');
}

function hideNodePanel() {
  document.getElementById('graph-node-panel')?.classList.remove('gv-panel-open');
}

function updateButtonStates() {
  const createEdgeBtn = document.getElementById('graph-create-edge');
  const deleteBtn = document.getElementById('graph-delete');
  createEdgeBtn.disabled = selectedNodes.length !== 2;
  deleteBtn.disabled = selectedNodes.length === 0;
}

function populateTypeFilter() {
  const select = document.getElementById('graph-filter-type');
  // Clear existing options beyond the default
  while (select.options.length > 1) select.remove(1);
  const types = [...new Set(graphData.nodes.map(n => n.type))].sort();
  const config = getNodeTypeConfig();
  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = (config[type]?.label || type);
    select.appendChild(option);
  });
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
  // Zoom controls
  document.getElementById('graph-zoom-fit')?.addEventListener('click', () => {
    if (network) network.fit({ animation: true });
  });
  document.getElementById('graph-zoom-in')?.addEventListener('click', () => {
    if (network) network.moveTo({ scale: network.getScale() * 1.3, animation: true });
  });
  document.getElementById('graph-zoom-out')?.addEventListener('click', () => {
    if (network) network.moveTo({ scale: network.getScale() / 1.3, animation: true });
  });

  // Search
  document.getElementById('graph-search')?.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    if (!query || !network) {
      if (network) network.selectNodes([]);
      return;
    }
    const matches = graphData.nodes
      .filter(n => n.label.toLowerCase().includes(query) || (n.description && n.description.toLowerCase().includes(query)))
      .map(n => n.id);
    if (matches.length > 0) {
      network.selectNodes(matches);
      network.focus(matches[0], { animation: true, scale: 1.2 });
    }
  });

  // Type filter — highlight matching nodes without destroying graph state
  document.getElementById('graph-filter-type')?.addEventListener('change', (e) => {
    if (!network) return;
    const type = e.target.value;
    if (!type) {
      network.selectNodes([]);
      return;
    }
    const ids = graphData.nodes.filter(n => n.type === type).map(n => n.id);
    network.selectNodes(ids);
    if (ids.length > 0) network.focus(ids[0], { animation: true });
  });

  // Refresh
  document.getElementById('graph-refresh')?.addEventListener('click', () => {
    initialized = false;
    initGraph();
  });

  // Close panel
  document.getElementById('panel-close')?.addEventListener('click', hideNodePanel);

  // ─── Create Modal ──────────────────────────────────────────────────────
  document.getElementById('graph-create-node')?.addEventListener('click', () => {
    document.getElementById('graph-create-modal')?.classList.add('gv-modal-open');
  });
  document.getElementById('cancel-create')?.addEventListener('click', () => {
    document.getElementById('graph-create-modal')?.classList.remove('gv-modal-open');
  });
  // Click backdrop to close
  document.getElementById('graph-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-create-modal') e.target.classList.remove('gv-modal-open');
  });

  document.getElementById('node-confidence')?.addEventListener('input', (e) => {
    document.getElementById('confidence-value').textContent = e.target.value;
  });

  document.getElementById('create-node-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      type: form.type.value,
      label: form.label.value,
      description: form.description.value,
      confidence: parseFloat(form.confidence.value)
    };
    try {
      const response = await fetch('/api/graph/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (result.success) {
        document.getElementById('graph-create-modal').classList.remove('gv-modal-open');
        form.reset();
        document.getElementById('confidence-value').textContent = '0.5';
        initialized = false;
        await initGraph();
      } else {
        showToast('Failed to create node: ' + result.error);
      }
    } catch (error) {
      showToast('Error: ' + error.message);
    }
  });

  // ─── Edit Modal ────────────────────────────────────────────────────────
  document.getElementById('cancel-edit')?.addEventListener('click', () => {
    document.getElementById('graph-edit-modal')?.classList.remove('gv-modal-open');
  });
  document.getElementById('graph-edit-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-edit-modal') e.target.classList.remove('gv-modal-open');
  });
  document.getElementById('edit-node-confidence')?.addEventListener('input', (e) => {
    document.getElementById('edit-confidence-value').textContent = e.target.value;
  });

  document.getElementById('edit-node-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nodeId = document.getElementById('edit-node-id').value;
    const data = {
      label: document.getElementById('edit-node-label').value,
      description: document.getElementById('edit-node-description').value,
      confidence: parseFloat(document.getElementById('edit-node-confidence').value),
    };
    try {
      const response = await fetch(`/api/graph/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (result.success) {
        document.getElementById('graph-edit-modal').classList.remove('gv-modal-open');
        initialized = false;
        await initGraph();
      } else {
        showToast('Failed to update node: ' + result.error);
      }
    } catch (error) {
      showToast('Error: ' + error.message);
    }
  });

  // ─── Connect Nodes ─────────────────────────────────────────────────────
  document.getElementById('graph-create-edge')?.addEventListener('click', async () => {
    if (selectedNodes.length !== 2) return;
    const edgeType = prompt('Edge type (e.g. close_to, feels_about, loves, helps_with):');
    if (!edgeType) return;
    try {
      const response = await fetch('/api/graph/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId: selectedNodes[0], toId: selectedNodes[1], type: edgeType })
      });
      const result = await response.json();
      if (result.success) { initialized = false; await initGraph(); }
      else showToast('Failed: ' + result.error);
    } catch (error) { showToast('Error: ' + error.message); }
  });

  // ─── Delete ────────────────────────────────────────────────────────────
  document.getElementById('graph-delete')?.addEventListener('click', async () => {
    if (selectedNodes.length === 0) return;
    if (!confirm(`Delete ${selectedNodes.length} selected node(s)?`)) return;
    for (const nodeId of selectedNodes) {
      try { await fetch(`/api/graph/nodes/${nodeId}`, { method: 'DELETE' }); }
      catch (err) { console.error('Delete failed:', nodeId, err); }
    }
    initialized = false;
    await initGraph();
  });
}

// ─── Edit Modal ──────────────────────────────────────────────────────────────

function openEditModal(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const modal = document.getElementById('graph-edit-modal');
  if (!modal) return;
  document.getElementById('edit-node-id').value = node.id;
  document.getElementById('edit-node-label').value = node.label;
  document.getElementById('edit-node-description').value = node.description || '';
  document.getElementById('edit-node-confidence').value = node.confidence;
  document.getElementById('edit-confidence-value').textContent = node.confidence;
  modal.classList.add('gv-modal-open');
}
globalThis.openEditModal = openEditModal;

// ─── Toast (replaces alert()) ────────────────────────────────────────────────

function showToast(msg) {
  let container = document.getElementById('gv-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'gv-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'gv-toast';
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('gv-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('gv-toast-visible');
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

globalThis.initGraph = initGraph;
