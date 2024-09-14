// scripture-scope/src/App.js
import React, { useEffect, useState, useRef } from 'react';
import { Container, Row, Col, Dropdown, DropdownButton, Modal, Button } from 'react-bootstrap';
import './App.css';
import './CircularProgress.css';
import { loadWasm } from './loadWasm';

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, signInWithPopup, GoogleAuthProvider, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { getFirestore, collection, query, onSnapshot } from "firebase/firestore";
import { useAuthState } from 'react-firebase-hooks/auth';

// Your web app's Firebase configuration
const firebaseConfig = {/*...*/};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const get_data_url = 'https://get-data-eaqfntsdta-uc.a.run.app';
const get_data_by_method_url = 'https://get-data-by-method-eaqfntsdta-uc.a.run.app';
const get_data_from_firestore_url = 'https://get-data-from-firestore-eaqfntsdta-uc.a.run.app';
const get_topics_url = 'https://get-topics-eaqfntsdta-uc.a.run.app';
const get_verse_details_url = 'https://get-verse-details-eaqfntsdta-uc.a.run.app';
const methods_url = 'https://methods-eaqfntsdta-uc.a.run.app';

function MenuBar({ username, setSelectedMethod, uploadProgress, handleSignInShow, handleShowRegister, selectedMethod }) {/*...*/}

function App() {
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showSignInModal, setShowSignInModal] = useState(false);
  const [username, setusername] = useState(null);

  const [wasmInstance, setWasmInstance] = useState(null);
  const canvasRef = useRef(null);

  const handleCloseRegister = () => setShowModal(false);
  const handleShowRegister = () => setShowModal(true);

  const handleSignInClose = () => setShowSignInModal(false);
  const handleSignInShow = () => setShowSignInModal(true);

  const auth = getAuth();

  const registerWithEmail = (email, password) => {/*...*/};
  const signInWithEmail = (email, password) => {/*...*/};
  const registerWithGoogle = () => {/*...*/};
  const signInWithGoogle = () => {/*...*/};

  const [verseDetails, setVerseDetails] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [selectedMethod, setSelectedMethod] = useState('');
  const onMethodChange = (method) => setSelectedMethod(method);
  const [selectedNode, setSelectedNode] = useState(null);
  const [data, setData] = useState(null);
  const [startTime, setStartTime] = useState(Date.now());
  const [elapsedTime, setElapsedTime] = useState(0);
  const [timer, setTimer] = useState(null);

  // Use an effect to update the elapsed time every second
  useEffect(() => {
    const newStartTime = Date.now();
    setStartTime(newStartTime);
    const interval = setInterval(() => {
      setElapsedTime((Date.now() - newStartTime) / 1000);
    }, 1000);
    setTimer(interval);

    return () => clearInterval(interval);
  }, [selectedMethod]);

  // Stop the timer when processing is done
  const handleProcessingDone = () => {
    clearInterval(timer);
    setTimer(null);
  };

  useEffect(() => {
    if (!selectedMethod) return;

    const fetchData = async () => {
      const db = getFirestore();
      const nodesCollection = collection(db, `nodes_${selectedMethod}`);
      const linksCollection = collection(db, `links_${selectedMethod}`);

      const nodesUnsubscribe = onSnapshot(nodesCollection, (snapshot) => {
        setNodes(snapshot.docs.map(doc => doc.data()));
      });

      const linksUnsubscribe = onSnapshot(linksCollection, (snapshot) => {
        setLinks(snapshot.docs.map(doc => doc.data()));
      });

      return () => {
        nodesUnsubscribe();
        linksUnsubscribe();
      };
    };

    fetchData();
  }, [selectedMethod]);

  useEffect(() => {
    console.log('Nodes:', nodes);
    console.log('Links:', links);
  }, [nodes, links]);

  const handleNodeClick = (node) => {
    setSelectedNode((currentNode) => currentNode && currentNode.id === node.id ? null : node);
  };

  useEffect(() => {
    console.log('Selected node:', selectedNode);
  }, [selectedNode]);

  useEffect(() => {
    const initializeWasm = async () => {
      const wasm = await loadWasm();
      setWasmInstance(wasm);
      wasm._initialize();
    };

    initializeWasm();
  }, []);

  useEffect(() => {
    if (wasmInstance && nodes.length > 0) {
      const jsonData = JSON.stringify(nodes);
      wasmInstance.ccall('setData', null, ['string'], [jsonData]);
      wasmInstance._render();
    }
  }, [wasmInstance, nodes]);

  useEffect(() => {
    if (wasmInstance) {
      const handleMouseClick = (event) => {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        wasmInstance._onMouseClick(x, y);
      };

      canvasRef.current.addEventListener('click', handleMouseClick);

      return () => {
        canvasRef.current.removeEventListener('click', handleMouseClick);
      };
    }
  }, [wasmInstance]);

  useEffect(() => {
    if (wasmInstance) {
      window.Module = {
        onNodeClick: (nodeId) => {
          console.log('Node clicked:', nodeId);
          setSelectedNode(nodes.find(node => node.id === nodeId));
          // Handle node click event, e.g., display node details
        },
      };
    }
  }, [wasmInstance]);

  return (
    <div style={{ height: '100vh', overflow: 'hidden' }}>
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

      <Row>
        <Col>
          <MenuBar
            username={username}
            setSelectedMethod={onMethodChange}
            uploadProgress={uploadProgress}
            handleSignInShow={handleSignInShow}
            handleShowRegister={handleShowRegister}
            selectedMethod={selectedMethod}
          />
          <p>Elapsed time: {elapsedTime.toFixed(2)} seconds</p>
        </Col>
      </Row>
      <Row>
        <Col xs={selectedNode ? 8 : 12} style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <canvas ref={canvasRef} width="800" height="600"></canvas>
          </div>
        </Col>
        {selectedNode && (
          <Col xs={4} style={{ transition: 'width 0.5s', zIndex: 2 }}>
            <div style={{
              padding: '20px',
              backgroundColor: '#f0f0f0',
              color: '#333',
              fontFamily: 'Arial, sans-serif',
            }}>
              <h2 style={{ fontSize: '20px', fontWeight: 'bold' }}>Node Details</h2>
              <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 100px)' }}>
                <p style={{ fontSize: '16px', margin: '10px 0' }}>Reference: {selectedNode.id}</p>
                <p style={{ fontSize: '16px', margin: '10px 0' }}>Topic: {selectedNode.group}</p>
                <p style={{ fontSize: '16px', margin: '10px 0' }}>Passage: {selectedNode.text}</p>
              </div>
            </div>
          </Col>
        )}
      </Row>
    </div>
  );
}

export default App;