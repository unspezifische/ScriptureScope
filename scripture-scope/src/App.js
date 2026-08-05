// scripture-scope/src/App.js
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Container, Row, Col, Dropdown, DropdownButton, Modal, Button } from 'react-bootstrap';
import './App.css';
// import './CircularProgress.css';

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import { getFirestore, collection, onSnapshot } from "firebase/firestore";
import firebaseConfig from './firebaseConfig';
import { getAllMethodMetadata, getMethodMetadata } from './methodCatalog';
import {
  formatRelationshipDistance,
  getLinkEndpointId,
  normalizeGraphData,
  normalizeGraphId,
  parseTopicVector,
} from './graphData';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
isAnalyticsSupported()
  .then((isSupported) => {
    if (isSupported) getAnalytics(app);
  })
  .catch(() => {
    // Analytics is optional and may be unavailable in tests or privacy-restricted browsers.
  });

const methods_url = 'https://methods-eaqfntsdta-uc.a.run.app';

const HIT_RADIUS_PX = 14;

const getGroupColor = (group) => {
  const label = String(group ?? 'Uncategorized');
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash << 5) - hash + label.charCodeAt(i);
    hash |= 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 45%)`;
};

const getStableJitter = (id, scale) => {
  const value = normalizeGraphId(id);
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  const angle = ((Math.abs(hash) % 360) * Math.PI) / 180;
  return { x: Math.cos(angle) * scale, y: Math.sin(angle) * scale };
};

export const prepareNodeForGraph = (node) => {
  const x = Number(node?.x);
  const y = Number(node?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return node;

  const vector = parseTopicVector(node?.topic_distribution);
  if (!vector || vector.length < 2) return node;

  let projectedX;
  let projectedY;

  if (vector.length <= 3) {
    const jitter = getStableJitter(node?.id, 0.004);
    projectedX = vector[0] + jitter.x;
    projectedY = vector[1] + jitter.y;
  } else {
    const magnitude = vector.reduce((sum, value) => sum + Math.abs(value), 0) || 1;
    projectedX = vector.reduce(
      (sum, value, index) => sum + (value / magnitude) * Math.cos((index / vector.length) * Math.PI * 2),
      0,
    );
    projectedY = vector.reduce(
      (sum, value, index) => sum + (value / magnitude) * Math.sin((index / vector.length) * Math.PI * 2),
      0,
    );
    const jitter = getStableJitter(node?.id, 0.012);
    projectedX += jitter.x;
    projectedY += jitter.y;
  }

  const dominantTopic = vector.reduce(
    (bestIndex, value, index) => (value > vector[bestIndex] ? index : bestIndex),
    0,
  );

  return {
    ...node,
    x: projectedX,
    y: projectedY,
    group: node.group ?? `Topic ${dominantTopic + 1}`,
    usesProjectedTopicLayout: true,
  };
};

const projectNodesToCanvas = (nodes, width, height) => {
  const numericNodes = nodes
    .map((node) => ({
      node,
      x: Number(node?.x),
      y: Number(node?.y),
    }))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));

  if (numericNodes.length === 0) return [];

  const minX = Math.min(...numericNodes.map((item) => item.x));
  const maxX = Math.max(...numericNodes.map((item) => item.x));
  const minY = Math.min(...numericNodes.map((item) => item.y));
  const maxY = Math.max(...numericNodes.map((item) => item.y));

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const padding = 24;
  const drawWidth = Math.max(width - padding * 2, 1);
  const drawHeight = Math.max(height - padding * 2, 1);

  return numericNodes.map((item) => ({
    node: item.node,
    id: normalizeGraphId(item.node.id),
    x: padding + ((item.x - minX) / rangeX) * drawWidth,
    y: padding + (1 - (item.y - minY) / rangeY) * drawHeight,
  }));
};

const findNearestProjectedNode = (projectedNodes, pointX, pointY, hitRadius = HIT_RADIUS_PX) => {
  if (!projectedNodes?.length) return null;

  let closest = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const projected of projectedNodes) {
    const dx = projected.x - pointX;
    const dy = projected.y - pointY;
    const distance = Math.hypot(dx, dy);

    if (distance <= hitRadius && distance < bestDistance) {
      closest = projected.node;
      bestDistance = distance;
    }
  }

  return closest;
};

function MenuBar({ setSelectedMethod, handleSignInShow, handleShowRegister, selectedMethod }) {
  const [methods, setMethods] = useState([]);
  const [methodsError, setMethodsError] = useState('');
  const [showMethodInfo, setShowMethodInfo] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    const loadMethods = async () => {
      try {
        const response = await fetch(methods_url);
        if (!response.ok) {
          throw new Error(`Failed to load methods (${response.status})`);
        }

        const payload = await response.json();
        const rawMethods = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.methods)
            ? payload.methods
            : Array.isArray(payload?.data)
              ? payload.data
              : [];

        const normalized = rawMethods
          .map((method) => {
            const id = (typeof method === 'string' ? method : String(method?.id ?? method?.name ?? '')).trim();
            if (!id) return null;
            const fallback = getMethodMetadata(id);
            const remoteMetadata = typeof method === 'object' ? method : {};
            const isBuiltIn = fallback.type !== 'Contributed dataset view';
            return {
              ...fallback,
              ...remoteMetadata,
              id,
              collectionKey: remoteMetadata.collectionKey || fallback.collectionKey || id,
              label: isBuiltIn ? fallback.label : remoteMetadata.label || fallback.label || id,
              selectorLabel: isBuiltIn
                ? fallback.selectorLabel
                : remoteMetadata.selectorLabel || remoteMetadata.label || fallback.selectorLabel || id,
              description: isBuiltIn
                ? fallback.description
                : remoteMetadata.description || fallback.description,
              calculation: isBuiltIn
                ? fallback.calculation
                : remoteMetadata.calculation || fallback.calculation,
              dataModel: remoteMetadata.dataModel || fallback.dataModel,
              relationshipModel: remoteMetadata.relationshipModel || fallback.relationshipModel,
              layout: remoteMetadata.layout || fallback.layout,
            };
          })
          .filter(Boolean);

        if (isCancelled) return;

        setMethods(normalized);
        setMethodsError('');

        if (!selectedMethod && normalized.length > 0) {
          const preferredMethod = normalized.find((method) => method.id.toLowerCase() === 'drl') ?? normalized[0];
          setSelectedMethod(preferredMethod.id);
        }
      } catch (error) {
        if (isCancelled) return;
        setMethodsError('Unable to load method list.');
      }
    };

    loadMethods();

    return () => {
      isCancelled = true;
    };
  }, [selectedMethod, setSelectedMethod]);

  const selectedMetadata = methods.find((method) => method.id === selectedMethod)
    ?? getMethodMetadata(selectedMethod || 'Method');
  const displayedMethods = methods.length > 0 ? methods : getAllMethodMetadata();
  const relationshipViews = methods.filter((method) => method.hasRelationships);
  const analysisPreviews = methods.filter((method) => !method.hasRelationships);

  return (
    <>
    <div className="app-topbar">
      <Container fluid>
        <Row className="align-items-center app-topbar-row">
          <Col xs={12} md={4} className="app-brand">
            <h1>ScriptureScope</h1>
            <p>Explore passage relationships and layouts</p>
          </Col>
          <Col xs={12} md={4} className="method-control">
            <div className="method-selector-group">
            <DropdownButton
              id="method-selector"
              title={selectedMethod ? selectedMetadata.selectorLabel || selectedMetadata.label : 'Select graph view'}
              variant="secondary"
            >
              {methods.length === 0 && <Dropdown.Item disabled>No methods available</Dropdown.Item>}
              {relationshipViews.length > 0 && <Dropdown.Header>Relationship graph layouts</Dropdown.Header>}
              {relationshipViews.map((method) => (
                  <Dropdown.Item
                    key={method.id}
                    active={method.id === selectedMethod}
                    onClick={() => setSelectedMethod(method.id)}
                  >
                    {method.selectorLabel || method.layout?.label || method.label}
                  </Dropdown.Item>
                ))}
              {analysisPreviews.length > 0 && <Dropdown.Header>Analysis previews · no links</Dropdown.Header>}
              {analysisPreviews.map((method) => (
                  <Dropdown.Item
                    key={method.id}
                    active={method.id === selectedMethod}
                    onClick={() => setSelectedMethod(method.id)}
                  >
                    {method.selectorLabel || method.label}
                  </Dropdown.Item>
                ))}
            </DropdownButton>
            <div className="method-help-control">
              <button
                type="button"
                className="method-info-button"
                aria-label={`Learn how ${selectedMetadata.label} is calculated`}
                title={`${selectedMetadata.label}: ${selectedMetadata.description}`}
                onClick={() => setShowMethodInfo(true)}
              >
                i
              </button>
              <div className="method-hover-card" role="tooltip">
                <strong>{selectedMetadata.label}</strong>
                <span>{selectedMetadata.description}</span>
                <small>Click for calculation details.</small>
              </div>
            </div>
            </div>
          </Col>
          <Col xs={12} md={4} className="account-actions-column">
            <div className="account-actions">
              <Button variant="outline-light" onClick={handleSignInShow}>Sign In</Button>
              <Button variant="primary" onClick={handleShowRegister}>Register</Button>
            </div>
          </Col>
        </Row>
        {methodsError && <p style={{ marginTop: '8px', color: '#fda4af' }}>{methodsError}</p>}
      </Container>
    </div>
    <Modal
      show={showMethodInfo}
      onHide={() => setShowMethodInfo(false)}
      centered
      scrollable
      size="lg"
      className="method-info-modal"
    >
      <Modal.Header closeButton>
        <Modal.Title>What the models and distances mean</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="method-modal-intro">
          A text model represents each passage, a relationship calculation decides which passages are linked, and a layout chooses their screen positions. Screen distance is not automatically the relationship score.
        </p>
        <div className="method-explanation-list">
          {displayedMethods.map((method) => (
            <article
              key={method.id}
              className={`method-explanation${method.id === selectedMethod ? ' is-selected' : ''}`}
            >
              <div className="method-explanation-heading">
                <h3>{method.label}</h3>
                <span>{method.type || 'Data method'}</span>
              </div>
              <p>{method.description}</p>
              {method.dataModel && (
                <p><strong>Data representation — {method.dataModel.label}:</strong> {method.dataModel.description}</p>
              )}
              {method.relationshipModel ? (
                <p><strong>Relationship — {method.relationshipModel.metricLabel}:</strong> {method.relationshipModel.calculation}</p>
              ) : (
                <p><strong>Relationship:</strong> This preview does not contain passage-to-passage links.</p>
              )}
              {method.layout && (
                <p><strong>Layout — {method.layout.label}:</strong> {method.layout.distanceMeaning}</p>
              )}
              <p><strong>View calculation:</strong> {method.calculation}</p>
              {Array.isArray(method.sources) && method.sources.length > 0 && (
                <p className="method-sources">
                  <strong>Learn more:</strong>{' '}
                  {method.sources.map((source, index) => (
                    <React.Fragment key={source.url}>
                      {index > 0 && ', '}
                      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a>
                    </React.Fragment>
                  ))}
                </p>
              )}
            </article>
          ))}
        </div>
      </Modal.Body>
    </Modal>
    </>
  );
}

function App() {
  const [rawNodes, setRawNodes] = useState([]);
  const [rawLinks, setRawLinks] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showSignInModal, setShowSignInModal] = useState(false);
  const canvasRef = useRef(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const activePointersRef = useRef(new Map());
  const pinchStartRef = useRef(null);
  const dragDistanceRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 800 });
  const initialViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  const [viewTransform, setViewTransform] = useState(initialViewTransform);
  const viewTransformRef = useRef(initialViewTransform);
  const pendingViewTransformRef = useRef(null);
  const viewAnimationFrameRef = useRef(null);
  const projectedNodesRef = useRef([]);
  const [isCanvasInteracting, setIsCanvasInteracting] = useState(false);
  const [isLegendExpanded, setIsLegendExpanded] = useState(false);

  const commitViewTransform = useCallback((nextTransform) => {
    const current = pendingViewTransformRef.current ?? viewTransformRef.current;
    const next = typeof nextTransform === 'function' ? nextTransform(current) : nextTransform;
    viewTransformRef.current = next;
    pendingViewTransformRef.current = next;

    if (viewAnimationFrameRef.current !== null) return;
    viewAnimationFrameRef.current = window.requestAnimationFrame(() => {
      viewAnimationFrameRef.current = null;
      const pendingTransform = pendingViewTransformRef.current;
      pendingViewTransformRef.current = null;
      if (pendingTransform) setViewTransform(pendingTransform);
    });
  }, []);

  useEffect(() => () => {
    if (viewAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(viewAnimationFrameRef.current);
    }
  }, []);

  const handleCloseRegister = () => setShowModal(false);
  const handleShowRegister = () => setShowModal(true);

  const handleSignInClose = () => setShowSignInModal(false);
  const handleSignInShow = () => setShowSignInModal(true);

  const registerWithEmail = (email, password) => {/*...*/};
  const signInWithEmail = (email, password) => {/*...*/};
  const registerWithGoogle = () => {/*...*/};
  const signInWithGoogle = () => {/*...*/};

  const [selectedMethod, setSelectedMethod] = useState('');
  const onMethodChange = (method) => setSelectedMethod(method);
  const selectedMethodMetadata = useMemo(
    () => getMethodMetadata(selectedMethod || 'Method'),
    [selectedMethod],
  );
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isLoadingGraph, setIsLoadingGraph] = useState(false);
  const [graphError, setGraphError] = useState('');

  useEffect(() => {
    if (!selectedMethod) return;

    setRawNodes([]);
    setRawLinks([]);
    setSelectedNode(null);
    setHoveredNode(null);
    commitViewTransform({ scale: 1, offsetX: 0, offsetY: 0 });
    setIsLegendExpanded(false);
    setElapsedTime(0);
    setIsLoadingGraph(true);
    setGraphError('');

    const startedAt = Date.now();
    const timerId = setInterval(() => {
      setElapsedTime((Date.now() - startedAt) / 1000);
    }, 100);

    let nodesReady = false;
    let linksReady = false;

    const markLoadedIfReady = () => {
      if (nodesReady && linksReady) {
        clearInterval(timerId);
        setElapsedTime((Date.now() - startedAt) / 1000);
        setIsLoadingGraph(false);
      }
    };

    const db = getFirestore();
    const collectionKey = selectedMethodMetadata.collectionKey || selectedMethod;
    const nodesCollection = collection(db, `nodes_${collectionKey}`);
    const linksCollection = collection(db, `links_${collectionKey}`);

    const nodesUnsubscribe = onSnapshot(
      nodesCollection,
      (snapshot) => {
        setRawNodes(snapshot.docs.map((doc) => {
          const data = doc.data();
          return { ...data, id: data.id ?? doc.id };
        }));
        if (!nodesReady) {
          nodesReady = true;
          markLoadedIfReady();
        }
      },
      (error) => {
        setGraphError((current) => current || `Unable to load nodes for ${selectedMethod}: ${error.message}`);
        if (!nodesReady) {
          nodesReady = true;
          markLoadedIfReady();
        }
      },
    );

    const linksUnsubscribe = onSnapshot(
      linksCollection,
      (snapshot) => {
        setRawLinks(snapshot.docs.map((doc) => doc.data()));
        if (!linksReady) {
          linksReady = true;
          markLoadedIfReady();
        }
      },
      (error) => {
        setGraphError((current) => current || `Unable to load links for ${selectedMethod}: ${error.message}`);
        if (!linksReady) {
          linksReady = true;
          markLoadedIfReady();
        }
      },
    );

    return () => {
      clearInterval(timerId);
      nodesUnsubscribe();
      linksUnsubscribe();
      setIsLoadingGraph(false);
    };
  }, [commitViewTransform, selectedMethod, selectedMethodMetadata.collectionKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasSize = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(Math.floor(rect.width), 1);
      const height = Math.max(Math.floor(rect.height), 1);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      setCanvasSize({ width, height });
    };

    updateCanvasSize();

    const resizeObserver = new ResizeObserver(updateCanvasSize);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', updateCanvasSize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateCanvasSize);
    };
  }, []);

  const normalizedGraph = useMemo(
    () => normalizeGraphData(rawNodes, rawLinks, {
      metric: selectedMethodMetadata.relationshipModel?.metricId,
      legacyValueKind: selectedMethodMetadata.relationshipModel?.scoreDirection === 'lower-is-closer'
        ? 'distance'
        : undefined,
    }),
    [rawLinks, rawNodes, selectedMethodMetadata.relationshipModel],
  );
  const { nodes, links, stats: graphStats } = normalizedGraph;

  const displayNodes = useMemo(
    () => nodes.map(prepareNodeForGraph),
    [nodes],
  );

  const projectedNodes = useMemo(
    () => projectNodesToCanvas(displayNodes, canvasSize.width, canvasSize.height),
    [displayNodes, canvasSize.height, canvasSize.width],
  );
  projectedNodesRef.current = projectedNodes;

  const projectedNodeMap = useMemo(() => {
    const map = new Map();
    for (const projectedNode of projectedNodes) {
      map.set(projectedNode.id, projectedNode);
    }
    return map;
  }, [projectedNodes]);

  const transformToScreen = useCallback((worldX, worldY) => ({
    x: worldX * viewTransform.scale + viewTransform.offsetX,
    y: worldY * viewTransform.scale + viewTransform.offsetY,
  }), [viewTransform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!isCanvasInteracting) {
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = 'rgba(120, 120, 120, 0.35)';
      ctx.beginPath();

      for (const link of links) {
        const sourceId = getLinkEndpointId(link.source);
        const targetId = getLinkEndpointId(link.target);
        const source = projectedNodeMap.get(sourceId);
        const target = projectedNodeMap.get(targetId);
        if (!source || !target) continue;

        const from = transformToScreen(source.x, source.y);
        const to = transformToScreen(target.x, target.y);
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      }
      ctx.stroke();
    }

    for (const projected of projectedNodes) {
      const drawPoint = transformToScreen(projected.x, projected.y);
      ctx.fillStyle = getGroupColor(projected.node.group);
      ctx.beginPath();
      ctx.arc(drawPoint.x, drawPoint.y, 1.8 * viewTransform.scale, 0, Math.PI * 2);
      ctx.fill();
    }

    if (selectedNode) {
      const highlighted = projectedNodeMap.get(normalizeGraphId(selectedNode.id));
      if (highlighted) {
        const drawPoint = transformToScreen(highlighted.x, highlighted.y);
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(drawPoint.x, drawPoint.y, 5.5 * viewTransform.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }, [isCanvasInteracting, links, projectedNodeMap, projectedNodes, selectedNode, transformToScreen, viewTransform.scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getLocalCanvasPoint = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const toWorld = (point, transform = viewTransformRef.current) => ({
      x: (point.x - transform.offsetX) / transform.scale,
      y: (point.y - transform.offsetY) / transform.scale,
    });

    const selectNodeAt = (point) => {
      const transform = viewTransformRef.current;
      const worldPoint = toWorld(point, transform);
      const clickedNode = findNearestProjectedNode(
        projectedNodesRef.current,
        worldPoint.x,
        worldPoint.y,
        HIT_RADIUS_PX / transform.scale,
      );

      if (clickedNode) {
        setSelectedNode((currentNode) => (
          currentNode && normalizeGraphId(currentNode.id) === normalizeGraphId(clickedNode.id)
            ? null
            : clickedNode
        ));
      }
    };

    const beginPan = (point) => {
      const transform = viewTransformRef.current;
      isPanningRef.current = true;
      panStartRef.current = {
        x: point.x,
        y: point.y,
        offsetX: transform.offsetX,
        offsetY: transform.offsetY,
      };
    };

    const updatePan = (point) => {
      const dx = point.x - panStartRef.current.x;
      const dy = point.y - panStartRef.current.y;
      dragDistanceRef.current = Math.max(dragDistanceRef.current, Math.hypot(dx, dy));

      commitViewTransform((current) => ({
        ...current,
        offsetX: panStartRef.current.offsetX + dx,
        offsetY: panStartRef.current.offsetY + dy,
      }));
      canvas.style.cursor = 'grabbing';
    };

    const beginPinch = (firstPoint, secondPoint) => {
      const transform = viewTransformRef.current;
      const midpoint = {
        x: (firstPoint.x + secondPoint.x) / 2,
        y: (firstPoint.y + secondPoint.y) / 2,
      };
      const worldMidpoint = toWorld(midpoint, transform);

      pinchStartRef.current = {
        distance: Math.max(Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y), 1),
        scale: transform.scale,
        worldX: worldMidpoint.x,
        worldY: worldMidpoint.y,
      };
      dragDistanceRef.current = Math.max(dragDistanceRef.current, 10);
    };

    const updatePinch = (firstPoint, secondPoint) => {
      if (!pinchStartRef.current) beginPinch(firstPoint, secondPoint);

      const distance = Math.max(
        Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y),
        1,
      );
      const midpoint = {
        x: (firstPoint.x + secondPoint.x) / 2,
        y: (firstPoint.y + secondPoint.y) / 2,
      };
      const nextScale = Math.min(
        8,
        Math.max(0.2, pinchStartRef.current.scale * (distance / pinchStartRef.current.distance)),
      );

      dragDistanceRef.current = Math.max(dragDistanceRef.current, 10);
      commitViewTransform({
        scale: nextScale,
        offsetX: midpoint.x - pinchStartRef.current.worldX * nextScale,
        offsetY: midpoint.y - pinchStartRef.current.worldY * nextScale,
      });
      canvas.style.cursor = 'grabbing';
    };

    const handlePointerMove = (event) => {
      const point = getLocalCanvasPoint(event.clientX, event.clientY);

      if (activePointersRef.current.has(event.pointerId)) {
        event.preventDefault();
        activePointersRef.current.set(event.pointerId, point);
      }

      if (activePointersRef.current.size >= 2 && pinchStartRef.current) {
        const [firstPointer, secondPointer] = [...activePointersRef.current.values()];
        updatePinch(firstPointer, secondPointer);
        return;
      }

      if (isPanningRef.current) {
        updatePan(point);
        return;
      }

      const transform = viewTransformRef.current;
      const worldPoint = toWorld(point, transform);
      const node = findNearestProjectedNode(
        projectedNodesRef.current,
        worldPoint.x,
        worldPoint.y,
        HIT_RADIUS_PX / transform.scale,
      );

      setHoveredNode(event.pointerType === 'mouse' ? node : null);
      setTooltipPosition({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 300)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 140)),
      });
      canvas.style.cursor = node ? 'pointer' : 'grab';
    };

    const handlePointerDown = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();

      if (typeof canvas.setPointerCapture === 'function') {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          // Some WebKit versions expose pointer capture but reject it for touch pointers.
        }
      }
      const point = getLocalCanvasPoint(event.clientX, event.clientY);
      activePointersRef.current.set(event.pointerId, point);

      if (activePointersRef.current.size === 1) {
        setIsCanvasInteracting(true);
        dragDistanceRef.current = 0;
        beginPan(point);
      } else if (activePointersRef.current.size === 2) {
        const [firstPointer, secondPointer] = [...activePointersRef.current.values()];
        beginPinch(firstPointer, secondPointer);
      }
      canvas.style.cursor = 'grabbing';
    };

    const handlePointerUp = (event) => {
      if (!activePointersRef.current.has(event.pointerId)) return;
      event.preventDefault();
      const releasedPoint = activePointersRef.current.get(event.pointerId)
        ?? getLocalCanvasPoint(event.clientX, event.clientY);

      if (typeof canvas.hasPointerCapture === 'function') {
        try {
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        } catch (error) {
          // Continue ending the gesture if WebKit has already released capture.
        }
      }
      activePointersRef.current.delete(event.pointerId);

      if (activePointersRef.current.size === 1) {
        const remainingPoint = [...activePointersRef.current.values()][0];
        beginPan(remainingPoint);
        pinchStartRef.current = null;
        return;
      }

      if (dragDistanceRef.current <= 6) selectNodeAt(releasedPoint);
      activePointersRef.current.clear();
      pinchStartRef.current = null;
      isPanningRef.current = false;
      setIsCanvasInteracting(false);
      canvas.style.cursor = 'grab';
    };

    const handleWindowPointerMove = (event) => {
      if (event.target !== canvas && activePointersRef.current.has(event.pointerId)) {
        handlePointerMove(event);
      }
    };

    const handleWheel = (event) => {
      event.preventDefault();

      const point = getLocalCanvasPoint(event.clientX, event.clientY);
      const worldBeforeZoom = toWorld(point);
      const zoomDirection = event.deltaY > 0 ? -1 : 1;
      const zoomFactor = zoomDirection > 0 ? 1.1 : 0.9;

      commitViewTransform((current) => {
        const nextScale = Math.min(8, Math.max(0.2, current.scale * zoomFactor));
        const nextOffsetX = point.x - worldBeforeZoom.x * nextScale;
        const nextOffsetY = point.y - worldBeforeZoom.y * nextScale;

        return {
          scale: nextScale,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
        };
      });
    };

    const handlePointerLeave = () => {
      setHoveredNode(null);
      if (!isPanningRef.current) canvas.style.cursor = 'grab';
    };

    const handlePointerCancel = () => {
      setHoveredNode(null);
      activePointersRef.current.clear();
      pinchStartRef.current = null;
      isPanningRef.current = false;
      setIsCanvasInteracting(false);
      canvas.style.cursor = 'grab';
    };

    const getTouchPoints = (touchList) => Array.from(touchList).map((touch) => ({
      id: touch.identifier,
      point: getLocalCanvasPoint(touch.clientX, touch.clientY),
    }));

    const handleTouchStart = (event) => {
      event.preventDefault();
      const touches = getTouchPoints(event.touches);
      if (touches.length === 1) {
        setIsCanvasInteracting(true);
        dragDistanceRef.current = 0;
        beginPan(touches[0].point);
      } else if (touches.length >= 2) {
        beginPinch(touches[0].point, touches[1].point);
      }
    };

    const handleTouchMove = (event) => {
      event.preventDefault();
      const touches = getTouchPoints(event.touches);
      if (touches.length >= 2) {
        updatePinch(touches[0].point, touches[1].point);
      } else if (touches.length === 1 && isPanningRef.current) {
        updatePan(touches[0].point);
      }
    };

    const handleTouchEnd = (event) => {
      event.preventDefault();
      const remainingTouches = getTouchPoints(event.touches);
      if (remainingTouches.length === 1) {
        beginPan(remainingTouches[0].point);
        pinchStartRef.current = null;
        return;
      }

      const changedTouch = event.changedTouches[0];
      if (changedTouch && dragDistanceRef.current <= 6) {
        selectNodeAt(getLocalCanvasPoint(changedTouch.clientX, changedTouch.clientY));
      }
      pinchStartRef.current = null;
      isPanningRef.current = false;
      setIsCanvasInteracting(false);
      canvas.style.cursor = 'grab';
    };

    const handleTouchCancel = (event) => {
      event.preventDefault();
      pinchStartRef.current = null;
      isPanningRef.current = false;
      setIsCanvasInteracting(false);
      canvas.style.cursor = 'grab';
    };

    const handleContextMenu = (event) => {
      event.preventDefault();
    };

    canvas.style.cursor = 'grab';
    const supportsPointerEvents = typeof window.PointerEvent === 'function';
    if (supportsPointerEvents) {
      canvas.addEventListener('pointerdown', handlePointerDown);
      canvas.addEventListener('pointermove', handlePointerMove);
      canvas.addEventListener('pointerleave', handlePointerLeave);
      window.addEventListener('pointermove', handleWindowPointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerCancel);
    } else {
      canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
      canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
      canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
      canvas.addEventListener('touchcancel', handleTouchCancel, { passive: false });
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      if (supportsPointerEvents) {
        canvas.removeEventListener('pointerdown', handlePointerDown);
        canvas.removeEventListener('pointermove', handlePointerMove);
        canvas.removeEventListener('pointerleave', handlePointerLeave);
        window.removeEventListener('pointermove', handleWindowPointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
      } else {
        canvas.removeEventListener('touchstart', handleTouchStart);
        canvas.removeEventListener('touchmove', handleTouchMove);
        canvas.removeEventListener('touchend', handleTouchEnd);
        canvas.removeEventListener('touchcancel', handleTouchCancel);
      }
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [commitViewTransform]);

  const zoomCanvas = (factor) => {
    commitViewTransform((current) => ({
      ...current,
      scale: Math.min(8, Math.max(0.2, current.scale * factor)),
    }));
  };

  const resetCanvasView = () => {
    commitViewTransform({ scale: 1, offsetX: 0, offsetY: 0 });
  };

  const nodeMapById = useMemo(() => {
    const map = new Map();
    for (const node of displayNodes) {
      map.set(normalizeGraphId(node.id), node);
    }
    return map;
  }, [displayNodes]);

  const selectedNodeConnections = useMemo(() => {
    if (!selectedNode) return [];

    const selectedId = normalizeGraphId(selectedNode.id);
    const connections = [];

    for (const link of links) {
      const sourceId = getLinkEndpointId(link.source);
      const targetId = getLinkEndpointId(link.target);
      const connectedId = sourceId === selectedId
        ? targetId
        : targetId === selectedId
          ? sourceId
          : null;
      const node = connectedId ? nodeMapById.get(connectedId) : null;
      if (node) connections.push({ node, link });
    }

    return connections.sort((first, second) => {
      const firstDistance = Number.isFinite(first.link.distance)
        ? first.link.distance
        : Number.POSITIVE_INFINITY;
      const secondDistance = Number.isFinite(second.link.distance)
        ? second.link.distance
        : Number.POSITIVE_INFINITY;
      return firstDistance - secondDistance;
    });
  }, [links, nodeMapById, selectedNode]);

  const legendItems = useMemo(() => {
    const counts = new Map();
    for (const node of displayNodes) {
      const group = String(node.group ?? 'Uncategorized');
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([group, count]) => ({
        group,
        count,
        color: getGroupColor(group),
      }));
  }, [displayNodes]);

  const projectedTopicNodeCount = useMemo(
    () => displayNodes.filter((node) => node.usesProjectedTopicLayout).length,
    [displayNodes],
  );

  const graphNotice = useMemo(() => {
    if (graphError) return graphError;
    if (isLoadingGraph || !selectedMethod) return '';
    if (nodes.length === 0 && graphStats.inputNodeCount === 0) {
      return `No node records were found for ${selectedMethod}.`;
    }
    if (nodes.length === 0) {
      return `None of the ${graphStats.inputNodeCount.toLocaleString()} node records contain a usable reference, passage, and position or topic vector.`;
    }
    if (projectedNodes.length === 0) {
      return `${selectedMethod} has ${nodes.length.toLocaleString()} nodes, but none contain usable x/y coordinates or a topic distribution.`;
    }
    if (links.length === 0 && projectedTopicNodeCount > 0) {
      return `Showing ${projectedNodes.length.toLocaleString()} topic-projected nodes. ${selectedMethod} does not currently provide relationship links.`;
    }
    if (links.length === 0) {
      return `Showing ${projectedNodes.length.toLocaleString()} nodes. ${selectedMethod} does not currently provide relationship links.`;
    }
    if (projectedTopicNodeCount > 0) {
      return `${projectedTopicNodeCount.toLocaleString()} nodes use a 2D projection of their topic distributions.`;
    }
    const removedRecordCount = graphStats.invalidNodeCount
      + graphStats.duplicateNodeCount
      + graphStats.invalidLinkCount
      + graphStats.duplicateLinkCount;
    if (removedRecordCount > 0) {
      const removedNodes = graphStats.invalidNodeCount + graphStats.duplicateNodeCount;
      const removedLinks = graphStats.invalidLinkCount + graphStats.duplicateLinkCount;
      return `Clean view: ${nodes.length.toLocaleString()} passages and ${links.length.toLocaleString()} unique links. Removed ${removedNodes.toLocaleString()} malformed or duplicate node${removedNodes === 1 ? '' : 's'} and ${removedLinks.toLocaleString()} invalid or repeated link record${removedLinks === 1 ? '' : 's'}.`;
    }
    return '';
  }, [graphError, graphStats, isLoadingGraph, links.length, nodes.length, projectedNodes.length, projectedTopicNodeCount, selectedMethod]);

  return (
    <div className="app-root">
      <Modal show={showModal} onHide={handleCloseRegister}>
        <Modal.Header closeButton>
          <Modal.Title>Register</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Button onClick={() => registerWithEmail('email', 'password')}>Register with Email</Button>
          <Button onClick={registerWithGoogle}>Register with Google</Button>
        </Modal.Body>
      </Modal>
      <Modal show={showSignInModal} onHide={handleSignInClose}>
        <Modal.Header closeButton>
          <Modal.Title>Sign In</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Button onClick={() => signInWithEmail('email', 'password')}>Sign In with Email</Button>
          <Button onClick={signInWithGoogle}>Sign In with Google</Button>
        </Modal.Body>
      </Modal>

      <header>
          <MenuBar
            setSelectedMethod={onMethodChange}
            handleSignInShow={handleSignInShow}
            handleShowRegister={handleShowRegister}
            selectedMethod={selectedMethod}
          />
          <div className="graph-status" role="status" aria-live="polite">
          <p>
            {isLoadingGraph
              ? `Load time: ${elapsedTime.toFixed(2)} seconds (loading...)`
              : `Load time: ${elapsedTime.toFixed(2)} seconds`}
          </p>
          <p className="graph-instructions desktop-instructions">
            Drag to pan, scroll to zoom, click a node for details.
          </p>
          <p className="graph-instructions touch-instructions">
            Drag to pan, pinch or use the controls to zoom, tap a node for details.
          </p>
          {selectedMethodMetadata.relationshipModel && (
            <p className="relationship-definition">
              <strong>Links:</strong>{' '}
              {selectedMethodMetadata.relationshipModel.metricLabel}. {selectedMethodMetadata.relationshipModel.scoreMeaning}; screen distance comes from the {selectedMethodMetadata.layout?.label || 'selected'} layout.
            </p>
          )}
          {graphNotice && (
            <p className={`graph-data-notice${graphError ? ' is-error' : ''}`}>{graphNotice}</p>
          )}
          </div>
      </header>
      <main className={`graph-layout${selectedNode ? ' has-details' : ''}`}>
        <section className="graph-workspace" aria-label="Verse relationship graph">
          <div className="canvas-shell">
            <canvas
              id="graph-canvas"
              ref={canvasRef}
              width="1200"
              height="800"
              className="visualization-canvas"
              aria-label="Interactive verse relationship graph. Drag to pan and select a node to view details."
            />

            <div className="canvas-controls" aria-label="Graph zoom controls">
              <button type="button" onClick={() => zoomCanvas(1.2)} aria-label="Zoom in">+</button>
              <button type="button" onClick={() => zoomCanvas(0.8)} aria-label="Zoom out">−</button>
              <button type="button" className="reset-view-button" onClick={resetCanvasView}>Reset</button>
            </div>

            {!isLoadingGraph && selectedMethod && projectedNodes.length === 0 && (
              <div className="graph-empty-state" role="alert">
                <strong>No graph to display</strong>
                <span>{graphNotice || 'This method did not return any plottable nodes.'}</span>
              </div>
            )}

            {hoveredNode && (
              <div
                className="node-tooltip"
                style={{
                  left: tooltipPosition.x + 12,
                  top: tooltipPosition.y + 12,
                }}
              >
                <strong>{hoveredNode.id}</strong>
                <div>{hoveredNode.text || 'No passage text available'}</div>
              </div>
            )}

            <div className={`color-legend${isLegendExpanded ? ' is-expanded' : ''}`}>
              <h4 className="desktop-legend-title">Color Key</h4>
              <button
                type="button"
                className="mobile-legend-toggle"
                aria-expanded={isLegendExpanded}
                aria-controls="color-legend-content"
                onClick={() => setIsLegendExpanded((current) => !current)}
              >
                <span>Color Key</span>
                <span className="legend-toggle-icon" aria-hidden="true">
                  {isLegendExpanded ? '−' : '+'}
                </span>
              </button>
              <div id="color-legend-content" className="legend-content">
                {legendItems.length === 0 && <p>No node data loaded yet.</p>}
                {legendItems.map((item) => (
                  <div key={item.group} className="legend-row">
                    <span className="legend-swatch" style={{ backgroundColor: item.color }} />
                    <span>{item.group}</span>
                    <span className="legend-count">{item.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {selectedNode && (
          <button
            type="button"
            className="mobile-details-backdrop"
            aria-label="Close node details"
            onClick={() => setSelectedNode(null)}
          />
        )}

        {selectedNode && (
          <section className="details-workspace" aria-label="Selected node details">
            <aside className="node-details-panel">
              <div className="mobile-sheet-handle" aria-hidden="true" />
              <div className="panel-header-row">
                <h2>Node Details</h2>
                <button
                  type="button"
                  className="close-panel-button"
                  onClick={() => setSelectedNode(null)}
                >
                  Close
                </button>
              </div>
              <p><strong>Reference:</strong> {selectedNode.id}</p>
              <p><strong>Topic:</strong> {selectedNode.group ?? 'Uncategorized'}</p>
              <p><strong>Passage:</strong> {selectedNode.text ?? 'No passage text available'}</p>

              <h3>Related Passages ({selectedNodeConnections.length})</h3>
              {selectedNodeConnections.length === 0 && <p>This node has no links in the current dataset.</p>}
              {selectedNodeConnections.length > 0 && (
                <ul className="connected-list">
                  {selectedNodeConnections.map(({ node: connectedNode, link }) => (
                    <li key={connectedNode.id}>
                      <button
                        type="button"
                        className="connected-node-button"
                        onClick={() => setSelectedNode(connectedNode)}
                      >
                        <span>{connectedNode.id}</span>
                        <small>
                          {formatRelationshipDistance(
                            link,
                            selectedMethodMetadata.relationshipModel?.distanceLabel,
                          )} · {Number.isFinite(link.distance) ? 'lower is closer' : 'higher is closer'}
                        </small>
                        {Array.isArray(link.sharedTerms) && link.sharedTerms.length > 0 && (
                          <small>Shared terms: {link.sharedTerms.join(', ')}</small>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
