/**
 * Knowledge Graph Visualization
 *
 * Interactive visualization of the knowledge graph using vis-network.
 */

// Node type colors
const NODE_COLORS = {
  person: { background: '#4CAF50', border: '#388E3C' },
  emotion: { background: '#E91E63', border: '#C2185B' },
  event: { background: '#2196F3', border: '#1976D2' },
  memory_ref: { background: '#9C27B0', border: '#7B1FA2' },
  topic: { background: '#FF9800', border: '#F57C00' },
  preference: { background: '#00BCD4', border: '#0097A7' },
  place: { background: '#795548', border: '#5D4037' },
  goal: { background: '#FFEB3B', border: '#FBC02D' },
  health: { background: '#F44336', border: '#D32F2F' },
  boundary: { background: '#607D8B', border: '#455A64' },
  tradition: { background: '#8BC34A', border: '#689F38' },
  insight: { background: '#FFC107', border: '#FFA000' },
  default: { background: '#9E9E9E', border: '#757575' }
};

// Perspective colors for node borders
const PERSPECTIVE_COLORS = {
  user: '#2196F3',
  entity: '#E91E63',
  shared: '#9E9E9E'
};

// Edge type colors and styles
const EDGE_STYLES = {
  feels_about: { color: '#E91E63', dashes: false },
  comforted_by: { color: '#4CAF50', dashes: false },
  stressed_by: { color: '#F44336', dashes: false },
  close_to: { color: '#2196F3', dashes: false },
  mentions: { color: '#9C27B0', dashes: true },
  loves: { color: '#E91E63', dashes: false },
  dislikes: { color: '#FF9800', dashes: false },
  helps_with: { color: '#4CAF50', dashes: false },
  worsens: { color: '#F44336', dashes: false },
  default: { color: '#9E9E9E', dashes: [5, 5] }
};

// Global state
let network = null;
let graphData = { nodes: [], edges: [] };
let selectedNodes = [];
let initialized = false;

// Initialize - handle both direct load and HTMX fragment load
async function initGraph() {
  if (initialized) return;
  console.log('[Graph] Initializing...');
  initialized = true;
  await loadGraphData();
  setupEventListeners();
  console.log('[Graph] Initialization complete');
}

// Check if DOM is already ready (for HTMX fragment loads)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraph);
} else {
  // DOM already loaded (HTMX fragment or cached page)
  initGraph();
}

// Also listen for HTMX load events
document.body.addEventListener('htmx:afterSwap', (e) => {
  if (e.detail.target?.id === 'chat' && document.getElementById('graph-container')) {
    initGraph();
  }
});

// Expose initialization function globally for Psycheros.js to call
globalThis.initGraphView = initGraph;

/**
 * Load graph data from API
 */
async function loadGraphData() {
  const container = document.getElementById('graph-container');

  if (!container) {
    console.error('Graph container not found');
    return;
  }

  try {
    console.log('[Graph] Fetching data from /api/graph...');
    const response = await fetch('/api/graph');
    if (!response.ok) {
      throw new Error('Failed to load graph data');
    }

    graphData = await response.json();
    console.log('[Graph] Data received:', graphData);

    if (!graphData.nodes || graphData.nodes.length === 0) {
      console.log('[Graph] No nodes, showing empty state');
      container.innerHTML = `
        <div class="graph-empty">
          <p>The knowledge graph is empty.</p>
          <p>Create nodes to start building your graph!</p>
        </div>
      `;
      return;
    }

    console.log('[Graph] Rendering graph with', graphData.nodes.length, 'nodes');
    renderGraph();
    populateTypeFilter();
  } catch (error) {
    console.error('Failed to load graph:', error);
    container.innerHTML = `
      <div class="graph-error">
        <p>Failed to load graph data.</p>
        <p class="error-message">${error.message}</p>
        <button onclick="loadGraphData()" class="btn btn--primary">Retry</button>
      </div>
    `;
  }
}

/**
 * Render the graph visualization
 */
function renderGraph() {
  const container = document.getElementById('graph-container');
  container.innerHTML = '';

  // Create vis.js dataset
  const nodes = new vis.DataSet(
    graphData.nodes.map(node => ({
      id: node.id,
      label: node.label.length > 20 ? node.label.substring(0, 17) + '...' : node.label,
      title: `${node.type}: ${node.label}\n${node.description || ''}\nConfidence: ${Math.round(node.confidence * 100)}%`,
      color: NODE_COLORS[node.type] || NODE_COLORS.default,
      borderWidth: 3,
      borderColor: PERSPECTIVE_COLORS[node.perspective] || PERSPECTIVE_COLORS.shared,
      font: { color: '#ffffff', size: 14 },
      shadow: true,
      data: node // Store original data
    }))
  );

  const edges = new vis.DataSet(
    graphData.edges.map(edge => {
      const style = EDGE_STYLES[edge.type] || EDGE_STYLES.default;
      return {
        id: edge.id,
        from: edge.fromId,
        to: edge.toId,
        label: edge.customType || edge.type,
        title: `${edge.type}\nWeight: ${Math.round(edge.weight * 100)}%`,
        color: { color: style.color, highlight: style.color },
        dashes: style.dashes,
        width: 1 + edge.weight * 2,
        font: { size: 10, align: 'middle' },
        smooth: { type: 'curvedCW', roundness: 0.2 },
        data: edge
      };
    })
  );

  // Network options
  const options = {
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -3000,
        centralGravity: 0.3,
        springLength: 150,
        springConstant: 0.05
      },
      stabilization: {
        iterations: 200
      }
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
      multiselect: true,
      navigationButtons: true,
      keyboard: {
        enabled: true
      }
    },
    nodes: {
      shape: 'dot',
      size: 20,
      scaling: {
        min: 10,
        max: 30,
        label: {
          enabled: true,
          min: 12,
          max: 18
        }
      }
    },
    edges: {
      arrows: {
        to: { enabled: true, scaleFactor: 0.8 }
      },
      smooth: {
        enabled: true,
        type: 'continuous'
      }
    }
  };

  // Create network
  network = new vis.Network(container, { nodes, edges }, options);

  // Event handlers
  network.on('click', handleNetworkClick);
  network.on('doubleClick', handleNetworkDoubleClick);
  network.on('stabilizationIterationsDone', () => {
    network.fit({ animation: true });
  });
}

/**
 * Handle network click
 */
function handleNetworkClick(params) {
  // Update selection - use network.getSelectedNodes() for accurate multi-select
  selectedNodes = network.getSelectedNodes() || [];
  updateButtonStates();

  // Show node details panel
  if (params.nodes && params.nodes.length === 1) {
    showNodePanel(params.nodes[0]);
  } else {
    hideNodePanel();
  }
}

/**
 * Handle network double click
 */
function handleNetworkDoubleClick(params) {
  if (params.nodes && params.nodes.length === 1) {
    const nodeId = params.nodes[0];
    // Focus on this node and its connections
    network.focus(nodeId, { animation: true, scale: 1.5 });
  }
}

/**
 * Show node details panel
 */
function showNodePanel(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const panel = document.getElementById('graph-node-panel');
  const label = document.getElementById('panel-node-label');
  const content = document.getElementById('panel-content');

  // Find connected nodes
  const connectedEdges = graphData.edges.filter(e =>
    e.fromId === nodeId || e.toId === nodeId
  );

  const connections = connectedEdges.map(edge => {
    const isFrom = edge.fromId === nodeId;
    const otherNodeId = isFrom ? edge.toId : edge.fromId;
    const otherNode = graphData.nodes.find(n => n.id === otherNodeId);
    const direction = isFrom ? '→' : '←';
    return `<li>${direction} <strong>${edge.customType || edge.type}</strong> ${otherNode?.label || otherNodeId}</li>`;
  }).join('');

  label.textContent = node.label;
  content.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Type:</span>
      <span class="detail-value">${node.type}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Perspective:</span>
      <span class="detail-value">${node.perspective}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Confidence:</span>
      <span class="detail-value">${Math.round(node.confidence * 100)}%</span>
    </div>
    ${node.description ? `
      <div class="detail-section">
        <h4>Description</h4>
        <p>${node.description}</p>
      </div>
    ` : ''}
    ${connections ? `
      <div class="detail-section">
        <h4>Connections (${connectedEdges.length})</h4>
        <ul class="connection-list">${connections}</ul>
      </div>
    ` : ''}
    <div class="detail-section">
      <h4>Node ID</h4>
      <code class="node-id">${node.id}</code>
    </div>
  `;

  panel.classList.remove('hidden');
}

/**
 * Hide node details panel
 */
function hideNodePanel() {
  const panel = document.getElementById('graph-node-panel');
  panel.classList.add('hidden');
}

/**
 * Update button enabled/disabled states
 */
function updateButtonStates() {
  const createEdgeBtn = document.getElementById('graph-create-edge');
  const deleteBtn = document.getElementById('graph-delete');

  // Enable edge creation when exactly 2 nodes selected
  createEdgeBtn.disabled = selectedNodes.length !== 2;

  // Enable delete when at least 1 node selected
  deleteBtn.disabled = selectedNodes.length === 0;
}

/**
 * Populate the type filter dropdown
 */
function populateTypeFilter() {
  const select = document.getElementById('graph-filter-type');
  const types = [...new Set(graphData.nodes.map(n => n.type))];

  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    select.appendChild(option);
  });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Zoom controls
  document.getElementById('graph-zoom-fit').addEventListener('click', () => {
    network.fit({ animation: true });
  });

  document.getElementById('graph-zoom-in').addEventListener('click', () => {
    const scale = network.getScale();
    network.moveTo({ scale: scale * 1.2, animation: true });
  });

  document.getElementById('graph-zoom-out').addEventListener('click', () => {
    const scale = network.getScale();
    network.moveTo({ scale: scale / 1.2, animation: true });
  });

  // Search
  document.getElementById('graph-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    if (!query) {
      // Show all nodes
      const allNodeIds = graphData.nodes.map(n => n.id);
      network.selectNodes([]);
      return;
    }

    // Find matching nodes
    const matches = graphData.nodes
      .filter(n =>
        n.label.toLowerCase().includes(query) ||
        (n.description && n.description.toLowerCase().includes(query))
      )
      .map(n => n.id);

    if (matches.length > 0) {
      network.selectNodes(matches);
      network.focus(matches[0], { animation: true, scale: 1.2 });
    }
  });

  // Type filter
  document.getElementById('graph-filter-type').addEventListener('change', (e) => {
    const type = e.target.value;
    if (!type) {
      network.setData({
        nodes: new vis.DataSet(graphData.nodes.map(n => ({ id: n.id }))),
        edges: new vis.DataSet(graphData.edges.map(e => ({ id: e.id, from: e.fromId, to: e.toId })))
      });
      return;
    }

    // Filter nodes by type
    const filteredNodeIds = graphData.nodes
      .filter(n => n.type === type)
      .map(n => n.id);

    // Highlight only these nodes
    network.selectNodes(filteredNodeIds);
    if (filteredNodeIds.length > 0) {
      network.focus(filteredNodeIds[0], { animation: true });
    }
  });

  // Refresh button
  document.getElementById('graph-refresh').addEventListener('click', loadGraphData);

  // Close panel
  document.getElementById('panel-close').addEventListener('click', hideNodePanel);

  // Create node button
  document.getElementById('graph-create-node').addEventListener('click', () => {
    document.getElementById('graph-create-modal').classList.remove('hidden');
  });

  // Cancel create
  document.getElementById('cancel-create').addEventListener('click', () => {
    document.getElementById('graph-create-modal').classList.add('hidden');
  });

  // Confidence slider
  document.getElementById('node-confidence').addEventListener('input', (e) => {
    document.getElementById('confidence-value').textContent = e.target.value;
  });

  // Create node form
  document.getElementById('create-node-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      type: form.type.value,
      label: form.label.value,
      description: form.description.value,
      perspective: form.perspective.value,
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
        document.getElementById('graph-create-modal').classList.add('hidden');
        form.reset();
        await loadGraphData();
      } else {
        alert('Failed to create node: ' + result.error);
      }
    } catch (error) {
      alert('Error creating node: ' + error.message);
    }
  });

  // Create edge button
  document.getElementById('graph-create-edge').addEventListener('click', async () => {
    if (selectedNodes.length !== 2) return;

    const edgeType = prompt('Enter edge type (e.g., close_to, feels_about, mentions):');
    if (!edgeType) return;

    try {
      const response = await fetch('/api/graph/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromId: selectedNodes[0],
          toId: selectedNodes[1],
          type: edgeType,
          perspective: 'shared'
        })
      });

      const result = await response.json();

      if (result.success) {
        await loadGraphData();
      } else {
        alert('Failed to create edge: ' + result.error);
      }
    } catch (error) {
      alert('Error creating edge: ' + error.message);
    }
  });

  // Delete button
  document.getElementById('graph-delete').addEventListener('click', async () => {
    if (selectedNodes.length === 0) return;

    const confirmed = confirm(`Delete ${selectedNodes.length} selected node(s)?`);
    if (!confirmed) return;

    for (const nodeId of selectedNodes) {
      try {
        await fetch(`/api/graph/nodes/${nodeId}`, { method: 'DELETE' });
      } catch (error) {
        console.error('Failed to delete node:', nodeId, error);
      }
    }

    await loadGraphData();
  });
}

// Export init function globally so psycheros.js can call it
globalThis.initGraph = initGraph;
