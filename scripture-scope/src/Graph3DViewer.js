import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getLinkEndpointId, normalizeGraphId } from './graphData';

const MAX_SPATIAL_PANELS = 8;

const numericVector = (value) => {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch (_error) {
    return [];
  }
};

const projectedDepth = (node) => {
  const semantic = numericVector(node.topicDistribution ?? node.topic_distribution);
  const lexical = numericVector(node.ldaTopicDistribution ?? node.lda_topic_distribution);
  const project = (values, phase) => values.reduce(
    (sum, value, index) => sum + value * Math.sin((index + 1) * 1.61803398875 + phase),
    0,
  );
  if (!semantic.length && !lexical.length) return 0;
  if (!semantic.length) return project(lexical, 1.3);
  if (!lexical.length) return project(semantic, 0.2);
  return project(semantic, 0.2) * 0.5 + project(lexical, 1.3) * 0.5;
};

const normalizeAxis = (values, extent) => {
  const finite = values.filter(Number.isFinite);
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const range = maximum - minimum || 1;
  return values.map((value) => (((value - minimum) / range) - 0.5) * extent);
};

export const projectNodesTo3D = (nodes) => {
  if (!nodes.length) return [];
  const xValues = nodes.map((node) => Number(node.x));
  const yValues = nodes.map((node) => Number(node.y));
  const zValues = nodes.map(projectedDepth);
  const xs = normalizeAxis(xValues, 20);
  const ys = normalizeAxis(yValues, 14);
  const zs = normalizeAxis(zValues, 16);
  return nodes.map((node, index) => ({ node, x: xs[index], y: ys[index], z: zs[index] }));
};

const groupColor = (group) => {
  const label = String(group ?? 'Uncategorized');
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = ((hash << 5) - hash + label.charCodeAt(index)) | 0;
  }
  return new THREE.Color().setHSL((Math.abs(hash) % 360) / 360, 0.7, 0.45);
};

const makePointTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  const glow = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.72, 'rgba(255,255,255,1)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const makeEnvironmentTexture = (baseColor) => {
  const base = new THREE.Color(baseColor);
  const top = base.clone().offsetHSL(0, -0.08, 0.2);
  const middle = base.clone();
  const bottom = base.clone().offsetHSL(0, 0.08, -0.24);
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `#${top.getHexString()}`);
  gradient.addColorStop(0.52, `#${middle.getHexString()}`);
  gradient.addColorStop(1, `#${bottom.getHexString()}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const makePanelSprite = (node, index) => {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(15, 23, 42, 0.94)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#60a5fa';
  context.lineWidth = 8;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = '#f8fafc';
  context.font = '700 38px system-ui, sans-serif';
  context.fillText(node.id, 28, 58);
  context.font = '26px system-ui, sans-serif';
  const words = String(node.text ?? 'No passage text available').split(/\s+/);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > 700 && line) {
      lines.push(line);
      line = word;
    } else line = candidate;
  });
  if (line) lines.push(line);
  lines.slice(0, 5).forEach((text, lineIndex) => context.fillText(text, 28, 108 + lineIndex * 40));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.8, 1.58, 1);
  sprite.userData.panelIndex = index;
  return sprite;
};

function Graph3DViewer({ nodes, links, focusNodeId = '', onFocusHandled }) {
  const mountRef = useRef(null);
  const sceneStateRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [environmentColor, setEnvironmentColor] = useState('#dbeafe');
  const [environmentMode, setEnvironmentMode] = useState('void');
  const [xrSupport, setXrSupport] = useState({ checked: false, vr: false, ar: false });
  const [showNavigationHint, setShowNavigationHint] = useState(true);
  const [showXrPromo, setShowXrPromo] = useState(false);
  const [transientMessage, setTransientMessage] = useState('');
  const projected = useMemo(() => projectNodesTo3D(nodes), [nodes]);

  const toggleSelection = useCallback((nodeId) => {
    const id = normalizeGraphId(nodeId);
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current.slice(-(MAX_SPATIAL_PANELS - 1)), id];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.xr?.isSessionSupported) {
      setXrSupport({ checked: true, vr: false, ar: false });
      setShowXrPromo(true);
      return undefined;
    }
    Promise.all([
      navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
      navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
    ]).then(([vr, ar]) => {
      if (cancelled) return;
      setXrSupport({ checked: true, vr, ar });
      if (vr || ar) setTransientMessage('Headset detected. Choose an environment, then enter XR.');
      else setShowXrPromo(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowNavigationHint(false), 8000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!showXrPromo) return undefined;
    const timer = window.setTimeout(() => setShowXrPromo(false), 6500);
    return () => window.clearTimeout(timer);
  }, [showXrPromo]);

  useEffect(() => {
    if (!transientMessage) return undefined;
    const timer = window.setTimeout(() => setTransientMessage(''), 5000);
    return () => window.clearTimeout(timer);
  }, [transientMessage]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    const color = new THREE.Color(environmentColor);
    const environmentTexture = makeEnvironmentTexture(environmentColor);
    scene.background = environmentTexture;
    scene.fog = new THREE.FogExp2(color, 0.018);
    const camera = new THREE.PerspectiveCamera(62, 1, 0.02, 500);
    camera.position.set(0, 2, 24);
    const rig = new THREE.Group();
    rig.add(camera);
    scene.add(rig);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.xr.enabled = true;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.minDistance = 0.25;
    controls.maxDistance = 100;

    const graphGroup = new THREE.Group();
    scene.add(graphGroup);
    const positions = new Float32Array(projected.length * 3);
    const colors = new Float32Array(projected.length * 3);
    const positionById = new Map();
    projected.forEach(({ node, x, y, z }, index) => {
      positions.set([x, y, z], index * 3);
      const nodeColor = groupColor(node.group);
      colors.set([nodeColor.r, nodeColor.g, nodeColor.b], index * 3);
      positionById.set(normalizeGraphId(node.id), new THREE.Vector3(x, y, z));
    });
    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    nodeGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pointTexture = makePointTexture();
    const nodeMaterial = new THREE.PointsMaterial({
      alphaTest: 0.08,
      map: pointTexture,
      size: 0.12,
      transparent: true,
      vertexColors: true,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(nodeGeometry, nodeMaterial);
    graphGroup.add(points);

    const linePositions = [];
    links.forEach((link) => {
      const source = positionById.get(getLinkEndpointId(link.source));
      const target = positionById.get(getLinkEndpointId(link.target));
      if (source && target) linePositions.push(source.x, source.y, source.z, target.x, target.y, target.z);
    });
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.12 });
    graphGroup.add(new THREE.LineSegments(lineGeometry, lineMaterial));

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.18;
    const pointer = new THREE.Vector2();
    let pointerStart = null;
    const pickFromRay = (origin, direction) => {
      raycaster.set(origin, direction);
      const hit = raycaster.intersectObject(points, false)[0];
      if (hit && projected[hit.index]) toggleSelection(projected[hit.index].node.id);
    };
    const onPointerDown = (event) => { pointerStart = { x: event.clientX, y: event.clientY }; };
    const onPointerUp = (event) => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(points, false)[0];
      if (hit && projected[hit.index]) toggleSelection(projected[hit.index].node.id);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', () => {
      const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
      const direction = new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld);
      pickFromRay(origin, direction);
    });
    rig.add(controller);

    const keys = new Set();
    const onKeyDown = (event) => keys.add(event.code);
    const onKeyUp = (event) => keys.delete(event.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = Math.min(clock.getDelta(), 0.05);
      const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 10 : 4) * delta;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      if (keys.has('KeyW')) rig.position.addScaledVector(forward, speed);
      if (keys.has('KeyS')) rig.position.addScaledVector(forward, -speed);
      if (keys.has('KeyA')) rig.position.addScaledVector(right, -speed);
      if (keys.has('KeyD')) rig.position.addScaledVector(right, speed);
      controls.update();
      renderer.render(scene, camera);
    });

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      camera.aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1), false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    sceneStateRef.current = { camera, controls, graphGroup, positionById, renderer, rig, scene };

    return () => {
      sceneStateRef.current = null;
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      controls.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      pointTexture.dispose();
      environmentTexture.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [environmentColor, links, projected, toggleSelection]);

  useEffect(() => {
    const state = sceneStateRef.current;
    if (!state) return;
    [...state.graphGroup.children].filter((child) => child.userData.isPanel).forEach((panel) => {
      state.graphGroup.remove(panel);
      panel.material.map.dispose();
      panel.material.dispose();
    });
    selectedIds.forEach((id, index) => {
      const item = projected.find(({ node }) => normalizeGraphId(node.id) === id);
      const position = state.positionById.get(id);
      if (!item || !position) return;
      const panel = makePanelSprite(item.node, index);
      panel.userData.isPanel = true;
      const angle = (index / Math.max(selectedIds.length, 1)) * Math.PI * 2;
      panel.position.copy(position).add(new THREE.Vector3(Math.cos(angle) * 1.8, 1.4 + (index % 2) * 0.5, Math.sin(angle) * 1.8));
      state.graphGroup.add(panel);
    });
  }, [projected, selectedIds]);

  useEffect(() => {
    if (!focusNodeId) return;
    const state = sceneStateRef.current;
    const position = state?.positionById.get(normalizeGraphId(focusNodeId));
    if (!state || !position) return;
    state.controls.target.copy(position);
    state.camera.position.copy(position).add(new THREE.Vector3(0, 1.5, 4));
    state.controls.update();
    toggleSelection(focusNodeId);
    if (onFocusHandled) onFocusHandled();
  }, [focusNodeId, onFocusHandled, toggleSelection]);

  useEffect(() => {
    const state = sceneStateRef.current;
    if (!state) return;
    const color = new THREE.Color(environmentColor);
    if (!state.renderer.xr.isPresenting || environmentMode === 'void') {
      if (state.scene.background?.isTexture) state.scene.background.dispose();
      state.scene.background = makeEnvironmentTexture(environmentColor);
    }
    state.scene.fog.color.copy(color);
  }, [environmentColor, environmentMode]);

  const enterXR = async () => {
    const state = sceneStateRef.current;
    if (!state || !navigator.xr) return;
    const sessionType = environmentMode === 'passthrough' ? 'immersive-ar' : 'immersive-vr';
    try {
      setTransientMessage(environmentMode === 'passthrough' ? 'Requesting passthrough permission…' : 'Starting immersive VR…');
      const options = environmentMode === 'passthrough'
        ? { requiredFeatures: ['local-floor'], optionalFeatures: ['dom-overlay'], domOverlay: { root: document.body } }
        : { optionalFeatures: ['local-floor', 'bounded-floor'] };
      const session = await navigator.xr.requestSession(sessionType, options);
      state.scene.background = environmentMode === 'passthrough' ? null : makeEnvironmentTexture(environmentColor);
      session.addEventListener('end', () => {
        if (sceneStateRef.current) sceneStateRef.current.scene.background = makeEnvironmentTexture(environmentColor);
        setTransientMessage('XR session ended. You can re-enter or choose another environment.');
      }, { once: true });
      await state.renderer.xr.setSession(session);
      setTransientMessage(environmentMode === 'passthrough' ? 'Passthrough session active.' : 'Void session active.');
    } catch (error) {
      setTransientMessage(`Unable to start ${environmentMode === 'passthrough' ? 'passthrough AR' : 'VR'}: ${error.message}`);
    }
  };

  const modeSupported = environmentMode === 'passthrough' ? xrSupport.ar : xrSupport.vr;
  const hasAnyXrSupport = xrSupport.vr || xrSupport.ar;

  return (
    <div className="graph-3d-viewer">
      <div ref={mountRef} className="graph-3d-mount" aria-label="Interactive three-dimensional passage relationship graph" />
      <div
        className={`graph-3d-controls${hasAnyXrSupport ? ' has-xr' : ' is-simplified'}`}
        title={hasAnyXrSupport ? undefined : 'This site also supports a VR version on compatible WebXR headsets.'}
      >
        {hasAnyXrSupport && (
          <div className="graph-3d-mode" role="group" aria-label="XR environment">
            <button type="button" className={environmentMode === 'void' ? 'is-active' : ''} onClick={() => setEnvironmentMode('void')} disabled={!xrSupport.vr}>Void</button>
            <button type="button" className={environmentMode === 'passthrough' ? 'is-active' : ''} onClick={() => setEnvironmentMode('passthrough')} disabled={!xrSupport.ar}>Passthrough</button>
          </div>
        )}
        <label className="environment-color-control" title="Choose the base color for the environment gradient. This site also supports VR on compatible headsets.">
          Environment color
          <input type="color" value={environmentColor} onChange={(event) => setEnvironmentColor(event.target.value)} />
        </label>
        {hasAnyXrSupport && (
          <button type="button" className="enter-xr-button" onClick={enterXR} disabled={!xrSupport.checked || !modeSupported}>
            Enter {environmentMode === 'passthrough' ? 'passthrough' : 'VR'}
          </button>
        )}
        {selectedIds.length > 0 && <button type="button" onClick={() => setSelectedIds([])}>Clear {selectedIds.length} panel{selectedIds.length === 1 ? '' : 's'}</button>}
        {showXrPromo && (
          <p className="graph-3d-promo" role="status">This site also supports a VR version!</p>
        )}
        {transientMessage && (
          <p className="graph-3d-notice" role="status">{transientMessage}</p>
        )}
      </div>
      {showNavigationHint && (
        <p className="graph-3d-help">Drag to orbit · right-drag to pan · scroll/pinch to zoom · W/A/S/D to travel · select nodes to pin up to {MAX_SPATIAL_PANELS} panels</p>
      )}
    </div>
  );
}

export default Graph3DViewer;
