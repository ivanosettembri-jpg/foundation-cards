import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

const FIREBASE_CONFIG = import.meta.env.VITE_FIREBASE_API_KEY ? {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "networkedcards.firebaseapp.com",
  projectId: "networkedcards",
  storageBucket: "networkedcards.firebasestorage.app",
  messagingSenderId: "1000213692591",
  appId: "1:1000213692591:web:b7220dd156dfffd388d45a"
} : null;

let _app = null, _auth = null, _db = null;

function init() {
  if (!FIREBASE_CONFIG || _app) return;
  _app  = initializeApp(FIREBASE_CONFIG);
  _auth = getAuth(_app);
  _db   = getFirestore(_app);
}

export function fbAuth() { init(); return _auth; }
export function fbDb()   { init(); return _db; }

export { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, doc, getDoc, setDoc };
