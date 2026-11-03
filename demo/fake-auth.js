import { resetDemo } from "./fake-firestore.js";

const user = { uid: "demo-me", email: "demo@example.com" };
export const getAuth = () => ({});
export const onAuthStateChanged = (auth, callback) => { setTimeout(() => callback(user)); };
export const signInWithEmailAndPassword = async () => {};
export const signOut = async () => { resetDemo(); location.reload(); };
