// scripture-scope/src/App.js
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Container, Dropdown, DropdownButton, Modal, Button } from 'react-bootstrap';
import './App.css';
import Graph3DViewer from './Graph3DViewer';
// import './CircularProgress.css';

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as isAnalyticsSupported } from "firebase/analytics";
import {
  collection,
  documentId,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  startAfter,
} from "firebase/firestore";
import firebaseConfig from './firebaseConfig';
import {
  getMethodMetadata,
  getPublishedLocalMethodMetadata,
} from './methodCatalog';
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
const NODE_PAGE_SIZE = 750;
const LINK_PAGE_SIZE = 1500;
const MIN_LEGEND_HEIGHT = 180;

export const clampLegendHeight = (height, viewportHeight) => {
  const maximum = Math.max(MIN_LEGEND_HEIGHT, Math.min(600, viewportHeight - 140));
  return Math.min(maximum, Math.max(MIN_LEGEND_HEIGHT, height));
};

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

const BOOK_ALIASES = {
  gen: 'genesis',
  exo: 'exodus',
  lev: 'leviticus',
  num: 'numbers',
  deu: 'deuteronomy',
  jos: 'joshua',
  jdg: 'judges',
  rut: 'ruth',
  '1sa': '1samuel',
  '2sa': '2samuel',
  '1ki': '1kings',
  '2ki': '2kings',
  '1ch': '1chronicles',
  '2ch': '2chronicles',
  ezr: 'ezra',
  neh: 'nehemiah',
  est: 'esther',
  job: 'job',
  pro: 'proverbs',
  ecc: 'ecclesiastes',
  sng: 'songofsolomon',
  isa: 'isaiah',
  jer: 'jeremiah',
  lam: 'lamentations',
  ezk: 'ezekiel',
  dan: 'daniel',
  hos: 'hosea',
  jol: 'joel',
  amo: 'amos',
  oba: 'obadiah',
  jon: 'jonah',
  mic: 'micah',
  nam: 'nahum',
  hab: 'habakkuk',
  zep: 'zephaniah',
  hag: 'haggai',
  zec: 'zechariah',
  mal: 'malachi',
  mat: 'matthew',
  mrk: 'mark',
  luk: 'luke',
  jn: 'john',
  jhn: 'john',
  act: 'acts',
  rom: 'romans',
  '1co': '1corinthians',
  '2co': '2corinthians',
  gal: 'galatians',
  eph: 'ephesians',
  col: 'colossians',
  '1th': '1thessalonians',
  '2th': '2thessalonians',
  '1ti': '1timothy',
  '2ti': '2timothy',
  tit: 'titus',
  phm: 'philemon',
  heb: 'hebrews',
  jas: 'james',
  '1pe': '1peter',
  '2pe': '2peter',
  '1jn': '1john',
  '2jn': '2john',
  '3jn': '3john',
  jud: 'jude',
  rev: 'revelation',
  lk: 'luke',
  mk: 'mark',
  mt: 'matthew',
  phil: 'philippians',
  phlp: 'philippians',
  php: 'philippians',
  ps: 'psalms',
  psa: 'psalms',
  psalm: 'psalms',
  sos: 'song',
  songofsolomon: 'song',
  songofsongs: 'song',
};

const normalizeBookName = (value) => {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/^iii\s+/, '3 ')
    .replace(/^ii\s+/, '2 ')
    .replace(/^i\s+/, '1 ')
    .replace(/\s+/g, '')
    .trim();
  return BOOK_ALIASES[normalized] ?? normalized;
};

const referenceKey = (value) => String(value ?? '')
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[–—]/g, '-')
  .replace(/[^a-z0-9]/g, '');

const parsePassageReference = (value) => {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const verseMatch = normalized.match(
    /^(.+?[A-Za-z])\s*(\d+):(\d+)(?:\s*-\s*(?:(\d+):)?(?::)?(\d+))?$/,
  );
  if (verseMatch) {
    const startChapter = Number(verseMatch[2]);
    const startVerse = Number(verseMatch[3]);
    const endChapter = verseMatch[4] ? Number(verseMatch[4]) : startChapter;
    const endVerse = verseMatch[5] ? Number(verseMatch[5]) : startVerse;
    return {
      book: normalizeBookName(verseMatch[1]),
      start: startChapter * 1000 + startVerse,
      end: endChapter * 1000 + endVerse,
      chapterOnly: false,
    };
  }

  const chapterMatch = normalized.match(/^(.+?[A-Za-z])\s*(\d+)$/);
  if (!chapterMatch) return null;
  const chapter = Number(chapterMatch[2]);
  return {
    book: normalizeBookName(chapterMatch[1]),
    start: chapter * 1000,
    end: chapter * 1000 + 999,
    chapterOnly: true,
  };
};

const bookNamesMatch = (queryBook, nodeBook) => (
  queryBook === nodeBook
  || (queryBook.length >= 3 && nodeBook.startsWith(queryBook))
);

export const findPassageNode = (nodes, query) => {
  const candidates = Array.isArray(nodes) ? nodes : [];
  const queryKey = referenceKey(query);
  if (!queryKey) return null;

  const exactMatch = candidates.find((node) => referenceKey(node?.id) === queryKey);
  if (exactMatch) return exactMatch;

  const parsedQuery = parsePassageReference(query);
  if (parsedQuery) {
    const containingRanges = candidates
      .map((node) => ({ node, reference: parsePassageReference(node?.id) }))
      .filter(({ reference }) => (
        reference
        && bookNamesMatch(parsedQuery.book, reference.book)
        && reference.start <= parsedQuery.start
        && reference.end >= parsedQuery.end
      ))
      .sort((first, second) => (
        (first.reference.end - first.reference.start)
        - (second.reference.end - second.reference.start)
      ));
    if (containingRanges.length > 0) return containingRanges[0].node;

    if (parsedQuery.chapterOnly) {
      const chapterRanges = candidates
        .map((node) => ({ node, reference: parsePassageReference(node?.id) }))
        .filter(({ reference }) => (
          reference
          && bookNamesMatch(parsedQuery.book, reference.book)
          && reference.start <= parsedQuery.end
          && reference.end >= parsedQuery.start
        ))
        .sort((first, second) => (
          (first.reference.end - first.reference.start)
          - (second.reference.end - second.reference.start)
          || first.reference.start - second.reference.start
        ));
      return chapterRanges[0]?.node ?? null;
    }

    return null;
  }

  return candidates.find((node) => referenceKey(node?.id).includes(queryKey)) ?? null;
};

function MenuBar({ setSelectedMethod, handleAccountShow, selectedMethod }) {
  const [methods, setMethods] = useState([]);
  const [methodsError, setMethodsError] = useState('');

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

        const activeMethodIds = new Set(getPublishedLocalMethodMetadata().map((method) => method.id));
        const normalizedRemoteMethods = rawMethods
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
          .filter((method) => method && activeMethodIds.has(method.id));

        const methodsById = new Map(
          normalizedRemoteMethods.map((method) => [method.id, method]),
        );
        getPublishedLocalMethodMetadata().forEach((method) => {
          if (!methodsById.has(method.id)) methodsById.set(method.id, method);
        });
        const normalized = [...methodsById.values()];

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
  const relationshipViews = methods.filter((method) => method.hasRelationships);
  const analysisPreviews = methods.filter((method) => !method.hasRelationships);

  return (
    <>
    <div className="app-topbar">
      <Container fluid>
        <div className="app-topbar-shell">
          <div className="app-brand">
            <h1>ScriptureScope</h1>
          </div>
          <div className="method-control">
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
            </div>
          </div>
          <div className="account-actions-column">
            <Button className="account-button" variant="outline-light" onClick={handleAccountShow}>
              Account
            </Button>
          </div>
        </div>
        {methodsError && <p style={{ marginTop: '8px', color: '#fda4af' }}>{methodsError}</p>}
      </Container>
    </div>
    </>
  );
}

function App() {
  const [rawNodes, setRawNodes] = useState([]);
  const [rawLinks, setRawLinks] = useState([]);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountMode, setAccountMode] = useState('login');
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
  const [legendHeight, setLegendHeight] = useState(320);
  const legendResizeRef = useRef(null);
  const [hiddenGroups, setHiddenGroups] = useState(() => new Set());

  const resizeLegendBy = useCallback((amount) => {
    setLegendHeight((current) => clampLegendHeight(current + amount, window.innerHeight));
  }, []);

  const handleLegendResizePointerDown = useCallback((event) => {
    event.preventDefault();
    legendResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: legendHeight,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, [legendHeight]);

  const handleLegendResizePointerMove = useCallback((event) => {
    const resize = legendResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setLegendHeight(clampLegendHeight(
      resize.startHeight + resize.startY - event.clientY,
      window.innerHeight,
    ));
  }, []);

  const handleLegendResizePointerEnd = useCallback((event) => {
    if (legendResizeRef.current?.pointerId !== event.pointerId) return;
    legendResizeRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleLegendResizeKeyDown = useCallback((event) => {
    if (event.key === 'ArrowUp') resizeLegendBy(24);
    else if (event.key === 'ArrowDown') resizeLegendBy(-24);
    else if (event.key === 'Home') setLegendHeight(MIN_LEGEND_HEIGHT);
    else if (event.key === 'End') setLegendHeight(clampLegendHeight(10000, window.innerHeight));
    else return;
    event.preventDefault();
  }, [resizeLegendBy]);

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

  const handleAccountShow = () => setShowAccountModal(true);
  const handleAccountClose = () => setShowAccountModal(false);

  const registerWithEmail = (email, password) => {/*...*/};
  const signInWithEmail = (email, password) => {/*...*/};
  const registerWithGoogle = () => {/*...*/};
  const signInWithGoogle = () => {/*...*/};

  const handleAccountSubmit = (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = formData.get('email');
    const password = formData.get('password');
    if (accountMode === 'signup') registerWithEmail(email, password);
    else signInWithEmail(email, password);
  };

  const [selectedMethod, setSelectedMethod] = useState('');
  const onMethodChange = (method) => setSelectedMethod(method);
  const selectedMethodMetadata = useMemo(
    () => getMethodMetadata(selectedMethod || 'Method'),
    [selectedMethod],
  );
  const isThreeDimensionalView = selectedMethodMetadata.viewDimension === '3d';
  const [selectedNode, setSelectedNode] = useState(null);
  const [passageQuery, setPassageQuery] = useState('');
  const [passageSearchMessage, setPassageSearchMessage] = useState('');
  const [pendingFocusNodeId, setPendingFocusNodeId] = useState('');
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isLoadingGraph, setIsLoadingGraph] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ nodes: 0, links: 0 });
  const [graphError, setGraphError] = useState('');

  useEffect(() => {
    document.title = selectedMethod ? `ScriptureScope - ${selectedMethod}` : 'ScriptureScope';
  }, [selectedMethod]);

  useEffect(() => {
    if (!selectedMethod) return;

    setRawNodes([]);
    setRawLinks([]);
    setSelectedNode(null);
    setPassageSearchMessage('');
    setPendingFocusNodeId('');
    setHoveredNode(null);
    commitViewTransform({ scale: 1, offsetX: 0, offsetY: 0 });
    setIsLegendExpanded(false);
    setHiddenGroups(new Set());
    setElapsedTime(0);
    setLoadingProgress({ nodes: 0, links: 0 });
    setIsLoadingGraph(true);
    setGraphError('');

    const startedAt = Date.now();
    const timerId = setInterval(() => {
      setElapsedTime((Date.now() - startedAt) / 1000);
    }, 100);

    let isCancelled = false;

    const db = getFirestore();
    const collectionKey = selectedMethodMetadata.collectionKey || selectedMethod;
    const nodesCollection = collection(db, `nodes_${collectionKey}`);
    const linksCollection = collection(db, `links_${collectionKey}`);

    const loadPages = async ({ reference, pageSize, ordering, onPage }) => {
      let cursor = null;
      while (!isCancelled) {
        const constraints = [ordering];
        if (cursor) constraints.push(startAfter(cursor));
        constraints.push(limit(pageSize));
        const snapshot = await getDocs(query(reference, ...constraints));
        if (isCancelled || snapshot.empty) return;
        onPage(snapshot.docs);
        cursor = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < pageSize) return;
        // Let React paint each completed page even when Firestore serves the next page from cache.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    const loadNodes = loadPages({
      reference: nodesCollection,
      pageSize: NODE_PAGE_SIZE,
      ordering: orderBy('loadPriority', 'asc'),
      onPage: (documents) => {
        const page = documents.map((doc) => {
          const data = doc.data();
          return { ...data, id: data.id ?? doc.id };
        });
        setRawNodes((current) => [...current, ...page]);
        setLoadingProgress((current) => ({ ...current, nodes: current.nodes + page.length }));
      },
    }).catch((error) => {
      if (!isCancelled) {
        setGraphError((current) => current || `Unable to load nodes for ${selectedMethod}: ${error.message}`);
      }
    });

    const loadLinks = loadPages({
      reference: linksCollection,
      pageSize: LINK_PAGE_SIZE,
      ordering: orderBy(documentId()),
      onPage: (documents) => {
        const page = documents.map((doc) => doc.data());
        setRawLinks((current) => [...current, ...page]);
        setLoadingProgress((current) => ({ ...current, links: current.links + page.length }));
      },
    }).catch((error) => {
      if (!isCancelled) {
        setGraphError((current) => current || `Unable to load links for ${selectedMethod}: ${error.message}`);
      }
    });

    Promise.all([loadNodes, loadLinks]).then(() => {
      if (isCancelled) return;
      clearInterval(timerId);
      setElapsedTime((Date.now() - startedAt) / 1000);
      setIsLoadingGraph(false);
    });

    return () => {
      isCancelled = true;
      clearInterval(timerId);
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
  }, [isThreeDimensionalView]);

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

  const allDisplayNodes = useMemo(
    () => nodes.map(prepareNodeForGraph),
    [nodes],
  );

  const displayNodes = useMemo(
    () => allDisplayNodes.filter(
      (node) => !hiddenGroups.has(String(node.group ?? 'Uncategorized')),
    ),
    [allDisplayNodes, hiddenGroups],
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

  useEffect(() => {
    if (isThreeDimensionalView) return undefined;
    if (!pendingFocusNodeId) return undefined;

    let secondFrameId;
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        const projected = projectedNodesRef.current.find(
          (item) => item.id === pendingFocusNodeId,
        );
        const canvas = canvasRef.current;
        if (!projected || !canvas) {
          setPendingFocusNodeId('');
          return;
        }

        const scale = Math.max(viewTransformRef.current.scale, 3);
        commitViewTransform({
          scale,
          offsetX: canvas.width / 2 - projected.x * scale,
          offsetY: canvas.height / 2 - projected.y * scale,
        });
        setPendingFocusNodeId('');
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId) window.cancelAnimationFrame(secondFrameId);
    };
  }, [commitViewTransform, isThreeDimensionalView, pendingFocusNodeId, projectedNodeMap]);

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

  const focusNode = (node) => {
    setSelectedNode(isThreeDimensionalView ? null : node);
    setPendingFocusNodeId(normalizeGraphId(node.id));
  };

  const handlePassageSearch = (event) => {
    event.preventDefault();
    const query = passageQuery.trim();
    if (!query) {
      setPassageSearchMessage('Enter a passage reference, such as John 3:16.');
      return;
    }

    const match = findPassageNode(displayNodes, query);
    if (!match) {
      setPassageSearchMessage(`No passage containing “${query}” was found in this graph.`);
      return;
    }

    focusNode(match);
    setPassageSearchMessage(`Centered on ${match.id}.`);
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
    for (const node of allDisplayNodes) {
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
  }, [allDisplayNodes]);

  const toggleGroupVisibility = useCallback((group) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const showAllGroups = useCallback(() => setHiddenGroups(new Set()), []);

  const hideAllGroups = useCallback(() => {
    setHiddenGroups(new Set(legendItems.map((item) => item.group)));
    setSelectedNode(null);
    setHoveredNode(null);
  }, [legendItems]);

  useEffect(() => {
    if (selectedNode && hiddenGroups.has(String(selectedNode.group ?? 'Uncategorized'))) {
      setSelectedNode(null);
    }
  }, [hiddenGroups, selectedNode]);

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

  const expectedNodeCount = selectedMethodMetadata.expectedCounts?.nodes ?? loadingProgress.nodes;
  const expectedLinkCount = selectedMethodMetadata.expectedCounts?.links ?? loadingProgress.links;
  const expectedDocumentCount = expectedNodeCount + expectedLinkCount;
  const loadedDocumentCount = Math.min(loadingProgress.nodes, expectedNodeCount)
    + Math.min(loadingProgress.links, expectedLinkCount);
  const loadingPercent = isLoadingGraph && expectedDocumentCount > 0
    ? Math.min(99, Math.floor((loadedDocumentCount / expectedDocumentCount) * 100))
    : selectedMethod ? 100 : 0;

  return (
    <div className="app-root">
      <Modal show={showAccountModal} onHide={handleAccountClose} centered>
        <Modal.Header closeButton>
          <Modal.Title>{accountMode === 'login' ? 'Log In' : 'Sign Up'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="account-mode-switch" role="group" aria-label="Account mode">
            <button
              type="button"
              aria-pressed={accountMode === 'login'}
              className={accountMode === 'login' ? 'is-active' : ''}
              onClick={() => setAccountMode('login')}
            >
              Log In
            </button>
            <button
              type="button"
              aria-pressed={accountMode === 'signup'}
              className={accountMode === 'signup' ? 'is-active' : ''}
              onClick={() => setAccountMode('signup')}
            >
              Sign Up
            </button>
          </div>
          <form className="account-form" onSubmit={handleAccountSubmit}>
            <label htmlFor="account-email">Email</label>
            <input id="account-email" name="email" type="email" autoComplete="email" required />
            <label htmlFor="account-password">Password</label>
            <input
              id="account-password"
              name="password"
              type="password"
              minLength="6"
              autoComplete={accountMode === 'login' ? 'current-password' : 'new-password'}
              required
            />
            <Button type="submit" variant="primary">
              {accountMode === 'login' ? 'Log In' : 'Create Account'}
            </Button>
            <Button
              type="button"
              variant="outline-secondary"
              onClick={accountMode === 'login' ? signInWithGoogle : registerWithGoogle}
            >
              Continue with Google
            </Button>
          </form>
        </Modal.Body>
      </Modal>

      <header>
          <MenuBar
            setSelectedMethod={onMethodChange}
            handleAccountShow={handleAccountShow}
            selectedMethod={selectedMethod}
          />
      </header>
      <main className={`graph-layout${selectedNode ? ' has-details' : ''}`}>
        <section className="graph-workspace" aria-label="Verse relationship graph">
          <div className="canvas-shell">
            {isThreeDimensionalView ? (
              <Graph3DViewer
                nodes={displayNodes}
                links={links}
                focusNodeId={pendingFocusNodeId}
                onFocusHandled={() => setPendingFocusNodeId('')}
              />
            ) : (
              <canvas
                id="graph-canvas"
                ref={canvasRef}
                width="1200"
                height="800"
                className="visualization-canvas"
                aria-label="Interactive verse relationship graph. Drag to pan and select a node to view details."
              />
            )}

            <div className="graph-toolbar">
              <div className="canvas-search-control">
                <form
                  className="passage-search-form"
                  role="search"
                  aria-label="Find a passage in the graph"
                  onSubmit={handlePassageSearch}
                >
                  <label className="visually-hidden" htmlFor="passage-search-input">Find passage</label>
                  <input
                    id="passage-search-input"
                    type="search"
                    inputMode="search"
                    value={passageQuery}
                    placeholder="Find passage…"
                    autoComplete="off"
                    onChange={(event) => {
                      setPassageQuery(event.target.value);
                      if (passageSearchMessage) setPassageSearchMessage('');
                    }}
                  />
                  <button type="submit" disabled={isLoadingGraph || displayNodes.length === 0}>
                    Find
                  </button>
                </form>
                {passageSearchMessage && (
                  <p className="passage-search-message" role="status" aria-live="polite">
                    {passageSearchMessage}
                  </p>
                )}
              </div>
              {!isThreeDimensionalView && (
                <div className="canvas-controls" aria-label="Graph zoom controls">
                  <button type="button" onClick={() => zoomCanvas(1.2)} aria-label="Zoom in">+</button>
                  <button type="button" onClick={() => zoomCanvas(0.8)} aria-label="Zoom out">−</button>
                  <button type="button" className="reset-view-button" onClick={resetCanvasView}>Reset</button>
                </div>
              )}
            </div>

            {selectedMethod && (
              <div
                className={`graph-loading-indicator${isLoadingGraph ? '' : ' is-loaded'}`}
                role="status"
                aria-live="polite"
              >
                <span className={`graph-progress-ring${isLoadingGraph ? '' : ' is-complete'}`} aria-hidden="true">
                  {isLoadingGraph && <span className="loading-spinner" />}
                  <span className="graph-progress-percent">{loadingPercent}%</span>
                </span>
                <span className="visually-hidden">{isLoadingGraph ? 'Loading graph' : 'Graph loaded'}</span>
                <span className="graph-load-copy" aria-hidden="true">
                  <span>{isLoadingGraph ? `Loading graph · ${elapsedTime.toFixed(2)}s` : `Graph loaded in ${elapsedTime.toFixed(2)}s`}</span>
                  <span className="graph-load-counts">
                    {loadingProgress.nodes.toLocaleString()} / {expectedNodeCount.toLocaleString()} nodes · {loadingProgress.links.toLocaleString()} / {expectedLinkCount.toLocaleString()} links
                  </span>
                </span>
                <span
                  className="graph-load-progress-track"
                  role="progressbar"
                  aria-label="Graph loading progress"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={loadingPercent}
                >
                  <span style={{ width: `${loadingPercent}%` }} />
                </span>
              </div>
            )}

            {!isLoadingGraph && selectedMethod && projectedNodes.length === 0 && (
              <div className="graph-empty-state" role="alert">
                <strong>No graph to display</strong>
                <span>{graphNotice || 'This method did not return any plottable nodes.'}</span>
              </div>
            )}

            {!isThreeDimensionalView && hoveredNode && (
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

            <div
              className={`color-legend${isLegendExpanded ? ' is-expanded' : ''}`}
              style={{ '--legend-drawer-height': `${clampLegendHeight(legendHeight, window.innerHeight)}px` }}
            >
              {isLegendExpanded && (
                <div
                  className="legend-resize-handle"
                  role="slider"
                  tabIndex="0"
                  aria-label="Resize Color Key drawer"
                  aria-orientation="vertical"
                  aria-valuemin={MIN_LEGEND_HEIGHT}
                  aria-valuemax={clampLegendHeight(10000, window.innerHeight)}
                  aria-valuenow={clampLegendHeight(legendHeight, window.innerHeight)}
                  onPointerDown={handleLegendResizePointerDown}
                  onPointerMove={handleLegendResizePointerMove}
                  onPointerUp={handleLegendResizePointerEnd}
                  onPointerCancel={handleLegendResizePointerEnd}
                  onKeyDown={handleLegendResizeKeyDown}
                >
                  <span aria-hidden="true" />
                </div>
              )}
              <header className="legend-drawer-header">
                <button
                  type="button"
                  className="mobile-legend-toggle"
                  aria-expanded={isLegendExpanded}
                  aria-controls="color-legend-content"
                  onClick={() => setIsLegendExpanded((current) => !current)}
                >
                  <span>Color Key</span>
                  <span className="legend-toggle-icon" aria-hidden="true">
                    {isLegendExpanded ? '⌄' : '⌃'}
                  </span>
                </button>
                {legendItems.length > 0 && (
                  <div className="legend-actions" aria-label="Topic visibility controls">
                    <button type="button" onClick={showAllGroups} disabled={hiddenGroups.size === 0}>
                      Show All
                    </button>
                    <button type="button" onClick={hideAllGroups} disabled={hiddenGroups.size === legendItems.length}>
                      Hide All
                    </button>
                    <span>{legendItems.length - hiddenGroups.size} of {legendItems.length} shown</span>
                  </div>
                )}
              </header>
              <div id="color-legend-content" className="legend-content">
                {legendItems.length === 0 && <p>No node data loaded yet.</p>}
                {legendItems.map((item) => (
                  <button
                    key={item.group}
                    type="button"
                    className={`legend-row${hiddenGroups.has(item.group) ? ' is-hidden' : ''}`}
                    aria-pressed={!hiddenGroups.has(item.group)}
                    title={`${hiddenGroups.has(item.group) ? 'Show' : 'Hide'} ${item.group}`}
                    onClick={() => toggleGroupVisibility(item.group)}
                  >
                    <span className="legend-swatch" style={{ backgroundColor: item.color }} />
                    <span>{item.group}</span>
                    <span className="legend-count">{item.count}</span>
                  </button>
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
            <aside className="node-details-panel" aria-labelledby="node-details-title">
              <header className="node-details-header">
                <div className="mobile-sheet-handle" aria-hidden="true" />
                <div className="panel-header-row">
                  <h2 id="node-details-title">Node Details</h2>
                  <button
                    type="button"
                    className="close-panel-button"
                    aria-label="Close node details"
                    onClick={() => setSelectedNode(null)}
                  >
                    Close
                  </button>
                </div>
              </header>
              <div className="node-details-content">
                <p><strong>Reference:</strong> {selectedNode.id}</p>
                <p><strong>{selectedNode.ldaTopicName ? 'BERTopic topic' : 'Topic'}:</strong> {selectedNode.group ?? 'Uncategorized'}</p>
                {selectedNode.ldaTopicName && (
                  <p><strong>LDA topic:</strong> {selectedNode.ldaTopicName}</p>
                )}
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
                          onClick={() => focusNode(connectedNode)}
                        >
                          <span>{connectedNode.id}</span>
                          <small>
                            {formatRelationshipDistance(
                              link,
                              selectedMethodMetadata.relationshipModel?.distanceLabel,
                            )} · {Number.isFinite(link.distance) ? 'lower is closer' : 'higher is closer'}
                          </small>
                          {Number.isFinite(link.bertopicDistance) && Number.isFinite(link.ldaDistance) && (
                            <small>
                              BERTopic: {link.bertopicDistance.toFixed(4)} · LDA: {link.ldaDistance.toFixed(4)}
                            </small>
                          )}
                          {Array.isArray(link.sharedTerms) && link.sharedTerms.length > 0 && (
                            <small>Shared terms: {link.sharedTerms.join(', ')}</small>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
