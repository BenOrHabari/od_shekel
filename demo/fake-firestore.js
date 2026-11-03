import { cycleIdOf } from "../logic.js?v=3";

const KEY = "od-shekel-demo";
const ROOT = "households/main";
let data = new Map();
const listeners = new Set();
let counter = 0;

const persist = () => {
  try { localStorage.setItem(KEY, JSON.stringify([...data])); } catch { /* the demo also works in memory */ }
};
const notify = () => { persist(); queueMicrotask(() => listeners.forEach((listener) => listener())); };

function seed() {
  data = new Map();
  data.set(ROOT, { income: 16000, deposit: 1000, members: { "demo-me": "אני", "demo-partner": "בן או בת זוג" } });
  const categories = [
    ["אוכל", "ongoing", 2600], ["בילויים", "ongoing", 600], ["בגדים", "ongoing", 300], ["מתנות", "ongoing", 200], ["דברים לבית", "ongoing", 300],
    ["שכר דירה", "bill", 5200], ["דלק", "bill", 900], ["חשמל", "bill", 350, "two"], ["מים", "bill", 80, "two"], ["גז", "bill", 60, "two"],
    ["ארנונה", "fixed", 500], ["קופת חופשות", "fixed", 400], ["ביטוח רכב", "fixed", 300], ["קופת חולים", "fixed", 200], ["סלולר", "fixed", 120], ["נטפליקס", "fixed", 70], ["Spotify", "fixed", 30], ["חדר כושר", "fixed", 180]
  ];
  categories.forEach(([name, type, amount, freq], order) => data.set(`${ROOT}/categories/demo${order}`, { name, type, amount, freq: freq || "month", order }));
  const monthId = cycleIdOf(new Date());
  [[0, "אוכל", 420, "סופר"], [0, "אוכל", 60, "שווארמה"], [1, "בילויים", 150, "מסעדה"]].forEach(([index, categoryName, amount, note], i) => {
    data.set(`${ROOT}/expenses/sample${i}`, { monthId, categoryId: `demo${index}`, categoryName, amount, note, by: "demo-me", spentAt: Date.now() - i * 86400000 });
  });
  persist();
}

try {
  const saved = localStorage.getItem(KEY);
  if (saved) data = new Map(JSON.parse(saved)); else seed();
} catch { seed(); }

export function resetDemo() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}

export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const serverTimestamp = () => Date.now();
export const doc = (parent, ...parts) => {
  if (parent.isCollection) return { path: `${parent.path}/${parts[0] || `auto${Date.now()}${++counter}`}` };
  if (parent.path) return { path: `${parent.path}/${parts.join("/")}` };
  return { path: parts.join("/") };
};
export const collection = (reference, name) => ({ path: `${reference.path}/${name}`, isCollection: true });
export const where = (field, operator, value) => ({ field, value });
export const query = (reference, filter) => ({ ...reference, filter });

const list = (target) => [...data.entries()]
  .filter(([path, value]) => {
    if (!path.startsWith(`${target.path}/`) || path.slice(target.path.length + 1).includes("/")) return false;
    return !target.filter || value[target.filter.field] === target.filter.value;
  })
  .map(([path, value]) => ({ id: path.split("/").pop(), ref: { path }, data: () => value }));

export const setDoc = async (reference, value) => { data.set(reference.path, value); notify(); };
export const addDoc = async (reference, value) => setDoc(doc(reference), value);
export const updateDoc = async (reference, value) => { data.set(reference.path, { ...data.get(reference.path), ...value }); notify(); };
export const deleteDoc = async (reference) => { data.delete(reference.path); notify(); };
export const getDocs = async (target) => ({ docs: list(target) });
export const writeBatch = () => {
  const steps = [];
  return {
    set: (reference, value) => steps.push(() => data.set(reference.path, value)),
    delete: (reference) => steps.push(() => data.delete(reference.path)),
    commit: async () => { steps.forEach((step) => step()); notify(); }
  };
};
export const onSnapshot = (target, callback) => {
  const fire = target.isCollection
    ? () => callback({ docs: list(target) })
    : () => callback({ exists: () => data.has(target.path), data: () => data.get(target.path) });
  listeners.add(fire);
  queueMicrotask(fire);
  return () => listeners.delete(fire);
};
