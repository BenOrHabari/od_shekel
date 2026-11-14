import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, doc, collection, setDoc, updateDoc, deleteDoc,
  addDoc, onSnapshot, query, where, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  cycleIdOf, cycleRange, cycleProgress, isTrial, summarize, forecast, coverOptions, plannedTotal, money, FIXED_GROUPS, fixedGroupOf,
  shiftCycle, closeResult, unpaidBills, bankTasks, SAFETY_TARGET, VACATION_FULL, DEFAULT_STATIONS, DEFAULT_FUNDS,
  stationProgress, stationsCrossed, insights, categoryAverages
} from "./logic.js?v=5";

// This config identifies the project and is public by design.
// Access to data is enforced by the Firestore security rules.
const app = initializeApp({
  apiKey: "AIzaSyCaGcDO83pldbO-AuQDzA8wzsGFnNwwwTw",
  authDomain: "odshekel1.firebaseapp.com",
  projectId: "odshekel1",
  storageBucket: "odshekel1.firebasestorage.app",
  messagingSenderId: "455176460904",
  appId: "1:455176460904:web:d55a936fdc06be7b4879dd"
});
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });

const home = doc(db, "households", "main");
const col = (name) => collection(home, name);

const TYPES = { ongoing: "שוטפות", bill: "חשבונות", fixed: "קבועות" };
const TYPE_ONE = { ongoing: "שוטפת", bill: "חשבון", fixed: "קבועה" };
const TYPE_HELP = {
  ongoing: "מזינים כל הוצאה, עם תיאור קצר",
  bill: "מגיע קבוע, והסכום משתנה",
  fixed: "יורדת לבד כל חודש באותו סכום"
};

const state = {
  user: null, household: undefined, categories: [], months: {}, monthsLoaded: false, allExpenses: [], allCovers: [],
  month: undefined, expenses: [], covers: [], closeId: null,
  view: "home", tab: "ongoing", pickedCategory: null, openGroups: new Set(), cycleId: cycleIdOf(new Date())
};
let unsubscribers = [];

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "disabled" || key === "hidden" || key === "required") node[key] = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
};

const safeWrite = (promise) => promise.catch((err) => toast(`השמירה נכשלה: ${err.code || err.message}`));
const parseAmount = (value) => Math.round(Number(String(value).replace(/[^\d.]/g, "")) || 0);

function toast(message, action) {
  document.querySelector(".toast")?.remove();
  const box = el("div", { class: "toast", role: "status" }, el("span", { text: message }));
  if (action) box.append(el("button", { type: "button", text: action.label, onclick: () => { box.remove(); action.run(); } }));
  document.body.append(box);
  setTimeout(() => box.remove(), action ? 7000 : 3500);
}

function openDialog(...children) {
  const layer = document.getElementById("layer");
  layer.replaceChildren(el("div", { class: "overlay" }, el("section", { class: "dialog", role: "dialog", "aria-modal": "true" }, ...children)));
}
const closeDialog = () => document.getElementById("layer").replaceChildren();

// ---------- data ----------

function stopListening() {
  unsubscribers.forEach((stop) => stop());
  unsubscribers = [];
}

function syncCurrent() {
  state.month = state.monthsLoaded ? (state.months[state.cycleId] || null) : undefined;
  state.expenses = state.allExpenses.filter((e) => e.monthId === state.cycleId);
  state.covers = state.allCovers.filter((c) => c.monthId === state.cycleId);
}

function listen() {
  stopListening();
  const ids = [state.cycleId, shiftCycle(state.cycleId, -1)];
  const onError = (err) => { state.loadError = err.code || err.message; render(); };
  const refresh = () => { syncCurrent(); ensureDefaults(); ensureMonth(); render(); };
  unsubscribers.push(onSnapshot(home, (snap) => {
    state.household = snap.exists() ? snap.data() : null;
    refresh();
  }, onError));
  unsubscribers.push(onSnapshot(col("categories"), (snap) => {
    state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.archived)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    refresh();
  }, onError));
  unsubscribers.push(onSnapshot(col("months"), (snap) => {
    state.months = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    state.monthsLoaded = true;
    refresh();
  }, onError));
  unsubscribers.push(onSnapshot(query(col("expenses"), where("monthId", "in", ids)), (snap) => {
    state.allExpenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.spentAt || 0) - (a.spentAt || 0));
    refresh();
  }, onError));
  unsubscribers.push(onSnapshot(query(col("covers"), where("monthId", "in", ids)), (snap) => {
    state.allCovers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    refresh();
  }, onError));
}

let defaultsRequested = false;
function ensureDefaults() {
  const h = state.household;
  if (!h || defaultsRequested || (h.stations && h.funds)) return;
  defaultsRequested = true;
  const update = {};
  if (!h.stations) update.stations = DEFAULT_STATIONS;
  if (!h.funds) update.funds = DEFAULT_FUNDS.map((f) => f.kind === "safety" ? { ...f, balance: Number(h.safety) || 0 } : f);
  safeWrite(updateDoc(home, update));
}

function checkCycle() {
  const id = cycleIdOf(new Date());
  if (id === state.cycleId || !state.user) return;
  state.cycleId = id;
  state.view = "home";
  syncCurrent();
  listen();
}

const snapshotBudgets = () => state.categories.map(({ id, name, type, amount, freq, group }) => ({ id, name, type, amount, freq: freq || "month", group: group || "" }));

function ensureMonth() {
  if (!state.monthsLoaded || state.month || !state.household || !state.categories.length) return;
  safeWrite(setDoc(doc(home, "months", state.cycleId), {
    budgets: snapshotBudgets(), income: state.household.income, deposit: state.household.deposit, createdAt: serverTimestamp()
  }));
}

const memberName = (uid) => state.household?.members?.[uid] || "";
const partnerUid = () => Object.keys(state.household?.members || {}).find((uid) => uid !== state.user.uid);

function monthSummary(id, depth = 0) {
  const month = state.months[id];
  if (!month) return null;
  const prev = state.months[shiftCycle(id, -1)];
  let carry = {};
  if (prev?.closed) carry = prev.closed.unpaid || {};
  else if (prev && depth === 0) carry = unpaidBills(monthSummary(shiftCycle(id, -1), 1));
  return summarize({
    budgets: month.budgets, income: month.income, deposit: month.deposit, carry,
    expenses: state.allExpenses.filter((e) => e.monthId === id),
    covers: state.allCovers.filter((c) => c.monthId === id)
  });
}

const currentSummary = () => monthSummary(state.cycleId);
const prevId = () => shiftCycle(state.cycleId, -1);
const pendingPrev = () => {
  const prev = state.months[prevId()];
  return prev && !prev.closed ? prev : null;
};

function prevResult() {
  const prev = pendingPrev();
  return prev ? closeResult(monthSummary(prevId()), fundOf("safety")?.balance) : null;
}

function currentTasks() {
  const done = state.month.bank || {};
  return bankTasks(state.month, prevResult(), fundsList()).map((task) => done[task.id] ? { ...task, ...done[task.id], done: true } : task)
    .concat(withdrawalTasks());
}


async function applyCategoriesNow() {
  const trial = isTrial(new Date());
  const update = {};
  if (trial) update.budgets = snapshotBudgets();
  if (Object.keys(update).length) await safeWrite(updateDoc(doc(home, "months", state.cycleId), update));
}

// ---------- screens ----------

function header(title, sub, actions = []) {
  return el("header", { class: "top" },
    el("div", { class: "stack" }, el("h1", { class: "display", text: title }), sub && el("p", { class: "quiet", text: sub })),
    actions.length ? el("div", {}, ...actions) : null);
}

function periodLabel() {
  const { start, end } = cycleRange(state.cycleId);
  const fmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long" });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

function viewHome() {
  const summary = currentSummary();
  const now = new Date();
  const progress = cycleProgress(state.cycleId, now);
  const predicted = forecast(summary, progress);
  const missingBills = summary.flexible.filter((l) => l.type === "bill" && l.spent === 0);
  const nodes = [header("עוד שקל לילד", periodLabel(), [el("span", { class: "pill", text: `עוד ${progress.left} ימים` })])];

  if ([5, 6].includes(now.getDay()) && !isTrial(now)) nodes.push(el("button", { class: "alert", type: "button", onclick: () => { state.storyIndex = 0; go("story"); } },
    el("span", { text: "הסיכום השבועי שלכם מחכה" }), el("span", { text: "לצפייה" })));
  const recs = insights(closedHistory(), state.categories, { snoozed: state.household.snoozed || {}, currentId: state.cycleId });
  if (recs.length) nodes.push(el("button", { class: "row card", type: "button", onclick: () => go("insights") },
    el("strong", { text: recs[0].kind === "reduce" ? `המלצה: עוד ${money(recs[0].diff)} לילד בכל חודש` : `המלצה לגבי ${recs[0].category.name}` }), el("span", { text: "לפרטים" })));

  if (isTrial(now)) nodes.push(el("p", { class: "note", text: "זו תקופת ניסיון. המחזור הראשון מתחיל ב-15 בנובמבר, ולפניו אפשר לאפס את הנתונים בהגדרות." }));

  summary.overspends.forEach((line) => nodes.push(el("button", {
    class: "alert", type: "button", onclick: () => openCover(line.id)
  }, el("span", { text: `חריגה של ${money(line.over)} ב${line.name}` }), el("span", { text: "לכיסוי" }))));

  const prev = pendingPrev();
  if (prev) monthSummary(prevId()).overspends.forEach((line) => nodes.push(el("button", {
    class: "alert", type: "button", onclick: () => openCover(line.id, 0, prevId())
  }, el("span", { text: `חריגה בחודש הקודם: ${money(line.over)} ב${line.name}` }), el("span", { text: "לכיסוי" }))));

  if (!isTrial(now)) {
    const tasks = currentTasks();
    const open = tasks.filter((t) => !t.done);
    if (open.length || prev) nodes.push(el("button", {
      class: "alert", style: "background:#14213D;color:#FFFFFF", type: "button", onclick: () => go("bank")
    }, el("span", { text: open.length ? `משימות בבנק: ${money(open.reduce((s, t) => s + t.amount, 0))} להעביר` : "כל ההעברות בוצעו, אפשר לסגור חודש" }),
    el("span", { style: "color:#FFB703", text: "לפתיחה" })));
  }

  const lastClosed = state.months[prevId()]?.closed;
  if (lastClosed && progress.elapsed <= 7) nodes.push(el("button", {
    class: "row card", type: "button", onclick: () => { state.closeId = prevId(); go("close"); }
  }, el("strong", { text: lastClosed.kid ? `החודש הקודם נסגר: עוד ${money(lastClosed.kid)} לילד` : "החודש הקודם נסגר" }), el("span", { text: "לסיכום" })));

  nodes.push(el("section", { class: "hero" },
    el("p", { class: "soft", text: "עוד אפשר לחסוך החודש" }),
    el("p", { class: "display big", text: `עד ${money(summary.canSave)}` }),
    el("p", { class: "soft", text: predicted === null ? "התחזית תופיע אחרי כמה ימים" : predicted > 0 ? `בקצב הנוכחי תחסכו כ-${money(predicted)}` : `נשארו ${progress.left} ימים, עדיין אפשר לשנות כיוון` })));

  nodes.push(el("button", { class: "primary", type: "button", text: "הוספת הוצאה", onclick: () => go("expenses", "ongoing") }));

  const total = savedTotal();
  const p = stationProgress(stationsList(), total);
  const medals = yearMedals();
  nodes.push(el("button", { class: "card", style: "border:0;font:inherit;color:inherit;text-align:right;gap:8px", type: "button", onclick: () => go("ladder") },
    el("span", { class: "row" }, el("span", { class: "quiet", text: "חסכתם מאז שהתחלנו" }), el("strong", { style: "font-size:22px", text: money(total) })),
    el("span", { class: "bar", style: "display:block" }, el("span", { style: `display:block;height:100%;width:${p.pct}%;background:#1F4FD8` })),
    el("span", { class: "row", style: "font-size:14px" }, el("span", { text: p.next ? `עוד ${money(p.left)} עד ${p.next.name}` : "עברתם את כל התחנות!" }), el("strong", { text: "למסלול" })),
    medals.length ? el("span", { style: "font-size:14px;font-weight:500;color:#1F4FD8", text: `מדליות השנה: ${medals.map((m) => m.name).join(", ")}` }) : null));

  if (missingBills.length && progress.left <= 5) nodes.push(el("button", {
    class: "alert", style: "background:#FFFFFF;border:2px solid #1F4FD8", type: "button", onclick: () => go("expenses", "bill")
  }, el("span", { text: `${missingBills.length} חשבונות מחכים לסכום` }), el("span", { text: "להזנה" })));

  const lines = [...summary.flexible].sort((a, b) => (b.available ? b.spent / b.available : 0) - (a.available ? a.spent / a.available : 0));
  nodes.push(el("section", { class: "card" }, el("h2", { text: "מה נשאר בכל תקציב" }),
    ...lines.map((line) => el("button", { class: "row line-item", style: "display:flex;flex-direction:column;align-items:stretch", type: "button", onclick: () => openCategory(line.id) },
      el("span", { style: "display:flex;justify-content:space-between;gap:12px" },
        el("span", { class: "name", text: line.name }),
        el("span", { text: line.over > 0 ? `חריגה ${money(line.over)}` : `נשארו ${money(line.left)}` })),
      el("span", { class: "bar", style: "display:block" }, el("span", {
        style: `display:block;height:100%;width:${Math.min(100, line.available ? (line.spent / line.available) * 100 : 0)}%;background:${line.over > 0 ? "#14213D" : "#1F4FD8"}`
      }))))));

  return nodes;
}

function go(view, tab) {
  state.view = view;
  if (tab) state.tab = tab;
  state.pickedCategory = null;
  closeDialog();
  render();
  window.scrollTo(0, 0);
}

function tabsBar() {
  return el("div", { class: "tabs" }, ...Object.entries(TYPES).map(([key, label]) => el("button", {
    type: "button", class: state.tab === key ? "on" : "", "aria-pressed": String(state.tab === key), text: label,
    onclick: () => { state.tab = key; state.pickedCategory = null; render(); }
  })));
}

function saveExpense(line, amount, note) {
  const ref = doc(col("expenses"));
  const now = new Date();
  safeWrite(setDoc(ref, {
    monthId: state.cycleId, categoryId: line.id, categoryName: line.name, amount, note,
    by: state.user.uid, spentAt: now.getTime(), createdAt: serverTimestamp()
  }));
  return ref;
}

function viewExpenses() {
  const summary = currentSummary();
  const nodes = [header("הוצאות", periodLabel(), [el("button", { class: "pill line", type: "button", text: "עריכה", onclick: () => go("categories", state.tab) })]), tabsBar()];
  if (state.tab === "fixed") return nodes.concat(fixedList(summary));

  const options = summary.flexible.filter((l) => l.type === state.tab);
  if (!options.some((l) => l.id === state.pickedCategory)) state.pickedCategory = null;
  const amountInput = el("input", { id: "amount", inputmode: "decimal", placeholder: "0", autocomplete: "off", "aria-label": "סכום" });
  const noteInput = el("input", { id: "note", class: "input", placeholder: state.tab === "bill" ? "למשל: חשבון ספטמבר־אוקטובר" : "למשל: שווארמה, סופר", autocomplete: "off" });
  const picked = options.find((l) => l.id === state.pickedCategory);
  const hint = picked ? el("p", { style: "text-align:center;font-size:15px", text: `ב${picked.name} הוצאתם עד עכשיו ${money(picked.spent)} מתוך ${money(picked.available)}` }) : null;
  const save = el("button", { class: "primary", type: "button", disabled: true, text: "שמירה" });
  const refresh = () => {
    save.disabled = !(parseAmount(amountInput.value) > 0 && noteInput.value.trim() && state.pickedCategory);
    save.textContent = save.disabled ? "ממלאים סכום, קטגוריה ותיאור" : "שמירה";
  };
  amountInput.addEventListener("input", refresh);
  noteInput.addEventListener("input", refresh);
  amountInput.value = state.draftAmount || "";
  noteInput.value = state.draftNote || "";
  const rememberDraft = () => { state.draftAmount = amountInput.value; state.draftNote = noteInput.value; };

  save.addEventListener("click", () => {
    const line = options.find((l) => l.id === state.pickedCategory);
    const amount = parseAmount(amountInput.value);
    const note = noteInput.value.trim();
    const over = line.spent + amount - line.available;
    saveExpense(line, amount, note);
    state.draftAmount = "";
    state.draftNote = "";
    state.pickedCategory = null;
    render();
    if (over > 0) openCover(line.id, over);
    else toast(`נשמר: ${money(amount)} על ${note}`);
  });

  nodes.push(el("section", { class: "card amount" }, el("label", { for: "amount", class: "quiet", text: "כמה יצא?" }),
    el("div", { style: "display:flex;align-items:baseline;gap:8px" }, amountInput, el("strong", { style: "font-size:28px", text: "₪" }))));
  nodes.push(el("section", { class: "card" }, el("h2", { text: state.tab === "bill" ? "איזה חשבון?" : "קטגוריה" }),
    el("div", { class: "chips" }, ...options.map((line) => el("button", {
      type: "button", class: `chip${state.pickedCategory === line.id ? " on" : ""}`, "aria-pressed": String(state.pickedCategory === line.id), text: line.name,
      onclick: () => { rememberDraft(); state.pickedCategory = line.id; render(); }
    })))));
  nodes.push(el("section", { class: "card" }, el("div", { class: "field" }, el("label", { for: "note", text: "על מה הוצאנו?" }), noteInput)));
  if (hint) nodes.push(hint);
  nodes.push(save);
  setTimeout(refresh);
  return nodes;
}

function fixedList(summary) {
  const fixed = state.categories.filter((c) => c.type === "fixed");
  const total = fixed.reduce((sum, c) => sum + c.amount, 0);
  const groups = FIXED_GROUPS.map((name) => ({ name, items: fixed.filter((c) => fixedGroupOf(c) === name) })).filter((g) => g.items.length);
  return [
    el("p", { class: "quiet", text: "יורדות לבד כל חודש. לחיצה על שורה פותחת עריכה." }),
    ...groups.map((group) => el("details", { class: "group", ...(state.openGroups.has(group.name) ? { open: "" } : {}), ontoggle: (event) => {
      if (event.currentTarget.open) state.openGroups.add(group.name); else state.openGroups.delete(group.name);
    } },
      el("summary", {}, el("span", { text: group.name }), el("span", { class: "sum", text: money(group.items.reduce((sum, c) => sum + c.amount, 0)) })),
      el("div", { class: "list" }, ...group.items.map((item) => el("button", { class: "row", type: "button", onclick: () => editCategory(item) },
        el("span", { text: item.name }), el("span", { text: money(item.amount) }))),
        group.name === "קופות" && el("div", { class: "row" }, el("span", { text: "קופת ביטחון" }), el("span", { class: "quiet", text: "לפי היתרה" }))))),
    el("button", { class: "dashed", type: "button", text: "הוספת הוצאה קבועה", onclick: () => editCategory({ name: "", amount: 0, type: "fixed", freq: "month", isNew: true }) }),
    el("p", { style: "font-weight:700;text-align:center", text: `סך הכול ${money(total)} בחודש` })
  ];
}

function openCategory(id) {
  const line = currentSummary().lines.find((l) => l.id === id);
  const items = state.expenses.filter((e) => e.categoryId === id);
  const list = items.length ? el("div", { class: "list" }, ...items.map((item) => el("div", { class: "row" },
    el("div", { class: "stack" }, el("strong", { text: item.note }), el("span", { class: "small", text: `${new Date(item.spentAt).toLocaleDateString("he-IL")} · ${memberName(item.by)}` })),
    el("div", { style: "display:flex;align-items:center;gap:6px" }, el("span", { text: money(item.amount) }),
      el("button", { class: "pill", type: "button", text: "מחיקה", "aria-label": `מחיקת ${item.note}`, onclick: () => askDelete(item) }))))) : el("p", { class: "quiet", text: "עוד אין הוצאות בסעיף הזה החודש" });
  openDialog(el("h2", { text: line.name }), el("p", { text: `${money(line.spent)} מתוך ${money(line.available)}` }), list,
    el("button", { class: "secondary", type: "button", text: "סגירה", onclick: closeDialog }));
}

function askDelete(item) {
  openDialog(el("h2", { text: "למחוק את ההוצאה?" }), el("p", { text: `${item.note}, ${money(item.amount)}` }),
    el("button", { class: "primary", type: "button", text: "מחיקה", onclick: () => {
      closeDialog();
      const { id, ...data } = item;
      safeWrite(deleteDoc(doc(col("expenses"), id)));
      toast("ההוצאה נמחקה", { label: "ביטול", run: () => safeWrite(setDoc(doc(col("expenses"), id), data)) });
    } }),
    el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
}

function openCover(lineId, overOverride, monthId = state.cycleId) {
  const summary = monthSummary(monthId);
  const line = summary.lines.find((l) => l.id === lineId);
  const over = Math.max(line.over, overOverride || 0);
  const budgetOptions = coverOptions(summary, lineId);
  const drawing = budgetOptions.length === 0;
  const options = drawing ? drawOptions(monthId) : budgetOptions;
  let chosen = null;
  const buttons = options.map((option) => {
    const after = Math.max(0, option.left - over);
    return el("button", { class: "option", type: "button", "data-id": option.id, onclick: (event) => {
      chosen = option;
      buttons.forEach((b) => b.classList.toggle("on", b === event.currentTarget));
      confirm.disabled = false;
    } }, el("span", { class: "stack" }, el("strong", { text: option.name }),
      el("span", { class: "small", text: option.id === "parents" ? "רק כמוצא אחרון. תופיע משימה לבקש את הסכום" : option.left >= over ? `${option.draw ? "תופיע משימת משיכה בבנק. " : ""}יישארו ${money(after)} מתוך ${money(option.left)}` : `יש כאן רק ${money(option.left)}, ואז נכסה את השאר` })));
  });
  const confirm = el("button", { class: "primary", type: "button", disabled: true, text: "מכסים עכשיו", onclick: async () => {
    const amount = Math.min(over, chosen.left);
    await safeWrite(addDoc(col("covers"), {
      monthId, fromId: chosen.id, fromName: chosen.name, toId: lineId, toName: line.name, amount, by: state.user.uid, createdAt: serverTimestamp()
    }));
    if (over - amount > 0) { setTimeout(() => openCover(lineId, over - amount, monthId), 300); return; }
    shareCover(line.name, over, chosen.name);
  } });
  const empty = options.length === 0;
  openDialog(el("h2", { class: "display", text: `חרגתם מ${line.name} ב-${money(over)}` }),
    el("p", { text: drawing ? "אין יותר מאיפה לכסות בתקציבים. מאיפה ניקח?" : "מאיפה נכסה את זה?" }),
    ...buttons, !drawing && el("p", { class: "small", text: "הסעיף שתבחרו לא יקבל מדליה החודש" }), !empty && confirm,
    el("button", { class: "secondary", type: "button", text: "אחר כך, עד סגירת החודש", onclick: closeDialog }));
}

function shareCover(lineName, amount, fromName) {
  const text = `קצת חרגנו ב${lineName} ב-${money(amount)}, אז לקחתי מ${fromName}. ממשיכים לחסוך!`;
  openDialog(el("h2", { class: "display", text: "כוסה! נעדכן את מאמי?" }), el("p", { class: "note", text: `״${text}״` }),
    el("a", { class: "primary", style: "display:flex;align-items:center;justify-content:center;text-decoration:none", href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener", text: "שולחים בוואטסאפ", onclick: () => setTimeout(closeDialog, 300) }),
    el("button", { class: "secondary", type: "button", text: "לא עכשיו", onclick: closeDialog }));
}

function viewCategories() {
  const budgets = state.categories;
  const planned = plannedTotal(budgets, state.household.deposit);
  const income = state.household.income;
  const items = budgets.filter((c) => c.type === state.tab);
  const fill = Math.min(100, (planned / income) * 100);
  return [
    header("עריכת קטגוריות", isTrial(new Date()) ? "בתקופת הניסיון שינויים נכנסים מיד" : "שינויים נכנסים מהחודש הבא", [el("button", { class: "pill", type: "button", text: "להוצאות", onclick: () => go("expenses") })]),
    el("section", { class: "hero", style: "padding:14px 16px;gap:8px" },
      el("div", { style: "display:flex;justify-content:space-between;gap:12px;font-weight:700" }, el("span", { text: `${planned.toLocaleString("en-US")} מתוך ${money(income)}` }), el("span", { text: planned <= income ? `נשארו ${money(income - planned)}` : `חריגה ${money(planned - income)}` })),
      el("div", { class: "bar", style: "background:#36466E" }, el("div", { style: `width:${fill}%;background:#FFB703` }))),
    tabsBar(),
    el("section", { class: "card list" }, ...items.map((item) => el("button", { class: "row", type: "button", onclick: () => editCategory(item) },
      el("span", { class: "stack" }, el("span", { style: "font-weight:500", text: item.name }), el("span", { class: "small", text: item.freq === "two" ? "כל חודשיים · ממוצע לחודש" : TYPE_HELP[item.type] })),
      el("span", { text: money(item.amount) })))),
    el("button", { class: "dashed", type: "button", text: "הוספה", onclick: () => editCategory({ name: "", amount: 0, type: state.tab, freq: "month", isNew: true }) })
  ];
}

function editCategory(item) {
  let type = item.type;
  let freq = item.freq || "month";
  let group = item.type === "fixed" ? fixedGroupOf(item) : "אחר";
  const name = el("input", { id: "cat-name", class: "input", value: item.name, placeholder: "שם" });
  const amount = el("input", { id: "cat-amount", class: "input", inputmode: "numeric", value: item.amount || "", placeholder: "₪" });
  const error = el("p", { class: "note", hidden: true, role: "alert" });
  const typeTabs = el("div", { class: "tabs" });
  const freqTabs = el("div", { class: "tabs", style: "grid-template-columns:repeat(2,minmax(0,1fr))" });
  const groupChips = el("div", { class: "chips" });
  const groupField = el("div", { class: "field" }, el("span", { style: "font-weight:700", text: "קבוצה" }), groupChips);
  const paint = () => {
    groupChips.replaceChildren(...FIXED_GROUPS.map((key) => el("button", { type: "button", class: `chip${group === key ? " on" : ""}`, text: key, onclick: () => { group = key; paint(); } })));
    groupField.hidden = type !== "fixed";
    typeTabs.replaceChildren(...Object.keys(TYPES).map((key) => el("button", { type: "button", class: type === key ? "on" : "", text: TYPE_ONE[key], onclick: () => { type = key; paint(); } })));
    freqTabs.replaceChildren(...[["month", "כל חודש"], ["two", "כל חודשיים"]].map(([key, label]) => el("button", { type: "button", class: freq === key ? "on" : "", text: label, onclick: () => { freq = key; paint(); } })));
    freqTabs.hidden = type !== "bill";
  };
  paint();
  const save = async () => {
    const value = parseAmount(amount.value);
    const cleanName = name.value.trim();
    if (!cleanName || !value) { error.textContent = "צריך שם וסכום"; error.hidden = false; return; }
    const others = state.categories.filter((c) => c.id !== item.id);
    const planned = plannedTotal(others, state.household.deposit) + value;
    if (planned > state.household.income) {
      error.textContent = `זה יעבור את ההכנסות ב-${money(planned - state.household.income)}. הורידו קודם מסעיף אחר.`;
      error.hidden = false;
      return;
    }
    const data = { name: cleanName, amount: value, type, freq: type === "bill" ? freq : "month", group: type === "fixed" ? group : "" };
    closeDialog();
    const lowered = !item.isNew && !isTrial(new Date()) && type !== "fixed" && item.type === type && value < item.amount;
    if (lowered) {
      const diff = item.amount - value;
      await safeWrite(updateDoc(doc(col("categories"), item.id), { ...data, amount: item.amount }));
      openDialog(el("h2", { class: "display", text: `להעביר לילד עוד ${money(diff)} בחודש?` }),
        el("p", { text: `זה ${money(diff * 12)} בשנה. אחרי חודש בתקציב החדש תקבלו מדליית שנה.` }),
        el("button", { class: "primary", type: "button", text: "מעבירים לילד", onclick: async () => { closeDialog(); await moveToChild({ ...item, name: cleanName }, diff, value); toast("מהחודש הבא"); } }),
        el("button", { class: "secondary", type: "button", text: "רק להוריד את התקציב", onclick: async () => { closeDialog(); await safeWrite(updateDoc(doc(col("categories"), item.id), { amount: value })); } }));
      return;
    }
    if (item.isNew) await safeWrite(addDoc(col("categories"), { ...data, order: Date.now() }));
    else await safeWrite(updateDoc(doc(col("categories"), item.id), data));
    if (!item.isNew && value > item.amount) deactivateAbove(item.id, value);
    setTimeout(async () => {
      await applyCategoriesNow();
      if (!isTrial(new Date()) && type === "fixed" && !item.isNew && item.type === "fixed") {
        const budgets = state.month.budgets.map((b) => b.id === item.id ? { ...b, amount: value } : b);
        await safeWrite(updateDoc(doc(home, "months", state.cycleId), { budgets }));
      }
    }, 300);
  };
  const remove = async () => {
    closeDialog();
    await safeWrite(updateDoc(doc(col("categories"), item.id), { archived: true }));
    setTimeout(applyCategoriesNow, 300);
    toast("הוסר מהחודש הבא");
  };
  openDialog(el("h2", { text: item.isNew ? "הוספה" : "עריכה" }),
    el("div", { class: "field" }, el("label", { for: "cat-name", text: "שם" }), name),
    el("div", { class: "field" }, el("span", { style: "font-weight:700", text: "סוג" }), typeTabs),
    el("div", { class: "field" }, el("label", { for: "cat-amount", text: "סכום לחודש" }), amount), freqTabs, groupField, error,
    el("button", { class: "primary", type: "button", text: "שמירה", onclick: save }),
    !item.isNew && el("button", { class: "secondary", type: "button", text: "הסרה", onclick: remove }),
    el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
}

function viewBank() {
  const trial = isTrial(new Date());
  const tasks = currentTasks();
  const prev = pendingPrev();
  const prevSummary = prev ? monthSummary(prevId()) : null;
  const blocked = prevSummary && prevSummary.openOver > 0;
  const allDone = tasks.every((t) => t.done);
  const total = tasks.filter((t) => !t.withdraw).reduce((s, t) => s + t.amount, 0);
  const nodes = [header("משימות בבנק", trial ? "יופיעו ב-15 בנובמבר" : periodLabel())];
  if (trial) nodes.push(el("p", { class: "note", text: "זו תצוגה מקדימה. ב-15 בנובמבר מסמנים כאן את ההעברות הראשונות." }));
  nodes.push(el("section", { class: "hero" }, el("p", { class: "soft", text: "להעביר החודש מהעו״ש" }), el("p", { class: "display big", text: money(total) })));

  const toggle = (task) => {
    if (trial) return;
    if (task.withdraw) { toggleWithdrawal(task); return; }
    const bank = { ...(state.month.bank || {}) };
    const undo = !!bank[task.id];
    if (undo) delete bank[task.id];
    else bank[task.id] = { amount: task.amount, kid: task.kid || 0, by: state.user.uid, at: Date.now() };
    safeWrite(updateDoc(doc(home, "months", state.cycleId), { bank }));
    if (task.fundKind) changeFund(task.fundKind, undo ? -task.amount : task.amount);
    if (task.redirected && !undo) toast("קופת החופשות מלאה, אז ההפקדה שלה עברה לילד");
  };
  nodes.push(el("section", { class: "card list" }, ...tasks.map((task) => el("button", {
    class: "row", type: "button", role: "checkbox", "aria-checked": String(!!task.done), disabled: trial,
    onclick: () => toggle(task)
  }, el("span", { style: "display:flex;align-items:center;gap:12px" },
    el("span", { "aria-hidden": "true", style: `width:28px;height:28px;flex:none;border-radius:8px;border:2px solid #1F4FD8;display:flex;align-items:center;justify-content:center;font-weight:700;color:#FFFFFF;background:${task.done ? "#1F4FD8" : "#FFFFFF"}`, text: task.done ? "✓" : "" }),
    el("span", { class: "stack" }, el("strong", { text: task.label }), el("span", { class: "small", text: task.done ? `בוצע · ${memberName(task.by)}` : task.detail }))),
  el("strong", { style: "white-space:nowrap", text: task.withdraw ? `−${money(task.amount)}` : money(task.amount) })))));

  if (blocked) nodes.push(el("p", { class: "note", text: `בחודש הקודם יש חריגה פתוחה של ${money(prevSummary.openOver)}. מכסים אותה במסך הבית, ואז אפשר לסגור.` }));
  if (prev) {
    nodes.push(el("button", { class: "primary", type: "button", disabled: trial || !allDone || blocked,
      text: allDone ? "סוגרים חודש ומקבלים מדליות" : "המדליות נפתחות אחרי שכל ההעברות בוצעו", onclick: closePrevMonth }));
  } else if (!trial) {
    nodes.push(el("p", { class: "note", text: allDone ? "כל ההעברות בוצעו. הסגירה הראשונה תהיה בחודש הבא." : "אחרי ההעברות, סמנו כל שורה." }));
  }
  return nodes;
}

async function closePrevMonth() {
  const id = prevId();
  const prev = state.months[id];
  if (!prev || prev.closed) return;
  const summary = monthSummary(id);
  const result = closeResult(summary, fundOf("safety")?.balance);
  const bank = state.month.bank || {};
  const kid = bank.invest ? bank.invest.kid || 0 : result.kid;
  const safety = bank.safety ? bank.safety.amount : 0;
  const lines = {};
  summary.flexible.forEach((l) => { if (!(l.type === "bill" && l.spent === 0)) lines[l.id] = { spent: l.spent, budget: l.available }; });
  const after = savedTotal();
  const before = after - (bank.invest?.amount || 0);
  const stations = stationsCrossed(stationsList(), before, after);
  const yearMedalsNow = [];
  const nextReductions = reductions().map((r) => {
    if (r.awarded || r.active === false || r.start > id) return r;
    const line = summary.lines.find((l) => l.id === r.catId);
    if (line && line.over === 0) {
      yearMedalsNow.push({ catId: r.catId, name: r.name, monthly: r.diff, annual: r.diff * 12 });
      return { ...r, awarded: true, awardedMonth: id };
    }
    return { ...r, start: shiftCycle(id, 1) };
  });
  await safeWrite(updateDoc(doc(home, "months", id), {
    closed: { at: Date.now(), by: state.user.uid, kid, safety, leftover: kid + safety, medals: result.medals, unpaid: result.unpaid, lines, stations, yearMedals: yearMedalsNow, notes: {} }
  }));
  if (reductions().length) await safeWrite(updateDoc(home, { reductions: nextReductions }));
  state.closeId = id;
  go("close");
}

function viewClose() {
  const id = state.closeId;
  const closed = state.months[id]?.closed;
  if (!closed) return [header("סגירת חודש", ""), el("p", { class: "quiet", text: "החודש עוד לא נסגר" })];
  const { start } = cycleRange(id);
  const monthName = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(start);
  const mine = closed.notes?.[state.user.uid] || "";
  const partner = partnerUid();
  const theirs = partner ? closed.notes?.[partner] : "";
  const note = el("textarea", { id: "close-note", class: "input", style: "min-height:84px;direction:rtl;font-family:inherit;font-size:16px", placeholder: "משפט אחד ליומן" });
  note.value = mine;
  const saveNote = () => {
    const notes = { ...(closed.notes || {}), [state.user.uid]: note.value.trim() };
    safeWrite(updateDoc(doc(home, "months", id), { closed: { ...closed, notes } })).then(() => toast("נשמר ביומן"));
  };
  return [
    header("סגרתם חודש", monthName, [el("button", { class: "pill", type: "button", text: "לבית", onclick: () => go("home") })]),
    el("section", { class: "hero", style: "background:#FFB703;color:#14213D;align-items:center;text-align:center" },
      el("p", { style: "font-weight:500", text: "המתנה של החודש" }),
      el("p", { class: "display", style: "font-size:40px;line-height:1.15", text: closed.kid ? `עוד ${money(closed.kid)} לילד` : "ההפקדה נכנסה" }),
      el("p", { text: closed.kid ? `חסכתם עד עכשיו ${money(savedTotal())}` : "החודש לא נשארה יתרה, ובכל זאת התקדמתם. ממשיכים!" })),
    ...(closed.stations || []).map((st) => el("p", { class: "alert", style: "justify-content:center", text: `תחנה חדשה: ${st.name}!` })),
    (closed.yearMedals || []).length ? el("section", { class: "hero", style: "gap:12px" }, el("h2", { class: "display", style: "font-size:22px", text: "מדליות השנה" }),
      el("div", { class: "chips" }, ...closed.yearMedals.map((m) => el("button", { type: "button", style: "aspect-ratio:1;border-radius:50%;border:4px solid #FFFFFF;background:#FFB703;color:#14213D;font:inherit;display:flex;flex-direction:column;align-items:center;justify-content:center", onclick: () => openBigMedal(m, `עמדתם חודש בתקציב החדש של ה${m.name}`) },
        el("span", { class: "display", style: "font-size:22px", text: money(m.annual) }), el("strong", { style: "font-size:13px", text: "כל שנה" }), el("span", { style: "font-size:14px;font-weight:700", text: m.name }))))) : null,
    el("section", { class: "card" }, el("h2", { text: "המדליות של החודש" }),
      ...(closed.medals.length ? closed.medals.map((m) => el("div", { class: "row" }, el("strong", { text: `מדליה: ${m.name}` }), el("span", { text: `${money(m.saved)} מתחת לתקציב` })))
        : [el("p", { class: "quiet", text: "הפעם בלי מדליות. בחודש הבא יש הזדמנות חדשה." })])),
    el("section", { class: "card" }, el("label", { for: "close-note", style: "font-weight:700", text: "מה תרצה לזכור מהחודש הזה?" }),
      theirs && el("p", { text: `${memberName(partner)} כתב/ה: ״${theirs}״` }), note,
      el("button", { class: "primary", type: "button", text: "שומרים ביומן", onclick: saveNote }))
  ];
}

// ---------- funds, withdrawals and savings ----------

const fundsList = () => state.household.funds || DEFAULT_FUNDS;
const fundOf = (kind) => fundsList().find((f) => f.kind === kind);

function changeFund(kind, delta) {
  const list = fundsList().map((f) => f.kind === kind ? { ...f, balance: Math.max(0, (Number(f.balance) || 0) + delta), updatedAt: Date.now() } : f);
  return safeWrite(updateDoc(home, { funds: list }));
}

const DRAW_SOURCES = {
  "draw-invest": { name: "מההפקדה לילד החודש", fund: "invest", tier: 1 },
  "draw-vacation-deposit": { name: "מההפקדה לקופת החופשות", fund: "vacation", tier: 1 },
  "draw-vacation": { name: "מקופת החופשות", fund: "vacation", tier: 2 },
  "draw-safety": { name: "מקופת הביטחון", fund: "safety", tier: 2 },
  parents: { name: "בקשה מההורים", fund: "", tier: 3 }
};

function drawOptions(monthId) {
  const month = state.months[monthId];
  const covers = state.allCovers.filter((c) => c.monthId === monthId || (DRAW_SOURCES[c.fromId] && !c.done));
  const used = (id) => covers.filter((c) => c.fromId === id && c.monthId === monthId).reduce((s, c) => s + c.amount, 0);
  const pending = (fund) => covers.filter((c) => !c.done && DRAW_SOURCES[c.fromId]?.fund === fund).reduce((s, c) => s + c.amount, 0);
  const vacationMonthly = month.budgets.filter((b) => b.type === "fixed" && /חופש/.test(b.name)).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const caps = {
    "draw-invest": (Number(month.deposit) || 0) - used("draw-invest"),
    "draw-vacation-deposit": vacationMonthly - used("draw-vacation-deposit"),
    "draw-vacation": (Number(fundOf("vacation")?.balance) || 0) - pending("vacation"),
    "draw-safety": (Number(fundOf("safety")?.balance) || 0) - pending("safety")
  };
  for (const tier of [1, 2]) {
    const options = Object.entries(DRAW_SOURCES).filter(([id, s]) => s.tier === tier && caps[id] > 0)
      .map(([id, s]) => ({ id, name: s.name, left: caps[id], draw: true }));
    if (options.length) return options;
  }
  return [{ id: "parents", name: "בקשה מההורים", left: Infinity, draw: true }];
}

function withdrawalTasks() {
  return state.allCovers.filter((c) => DRAW_SOURCES[c.fromId]).map((c) => {
    const source = DRAW_SOURCES[c.fromId];
    const parents = c.fromId === "parents";
    return {
      id: `cover-${c.id}`, coverId: c.id, monthId: c.monthId, amount: c.amount, done: !!c.done, by: c.doneBy, withdraw: true,
      label: parents ? "לבקש מההורים" : `למשוך ${source.name.replace(/^מה?/, "מ")} לעו״ש`,
      detail: `כיסוי חריגה ב${c.toName || "תקציב"}`, fundKind: source.fund
    };
  });
}

async function toggleWithdrawal(task) {
  const done = !task.done;
  await safeWrite(updateDoc(doc(col("covers"), task.coverId), { done, doneBy: done ? state.user.uid : null }));
  if (task.fundKind) await changeFund(task.fundKind, done ? -task.amount : task.amount);
  const month = state.months[task.monthId];
  if (task.fundKind === "invest" && month) {
    await safeWrite(updateDoc(doc(home, "months", task.monthId), { withdrawn: Math.max(0, (month.withdrawn || 0) + (done ? task.amount : -task.amount)) }));
  }
}

const savedTotal = () => Object.values(state.months).reduce((sum, m) => sum + (m.bank?.invest?.amount || 0) - (m.withdrawn || 0), 0);

// ---------- year medals ----------

const reductions = () => state.household.reductions || [];

function yearMedals() {
  const byCategory = {};
  reductions().filter((r) => r.awarded && r.active !== false).forEach((r) => {
    const key = r.catId;
    byCategory[key] = byCategory[key] || { catId: key, name: r.name, monthly: 0, months: [] };
    byCategory[key].monthly += r.diff;
    byCategory[key].months.push(r.awardedMonth);
  });
  return Object.values(byCategory).map((m) => ({ ...m, annual: m.monthly * 12 })).sort((a, b) => b.annual - a.annual);
}

async function moveToChild(category, diff, to) {
  const list = reductions().map((r) => r);
  list.push({ id: `r${Date.now()}`, catId: category.id, name: category.name, from: Number(category.amount) || 0, to, diff, start: shiftCycle(state.cycleId, 1), awarded: false, active: true });
  await safeWrite(updateDoc(doc(col("categories"), category.id), { amount: to }));
  await safeWrite(updateDoc(home, { deposit: (Number(state.household.deposit) || 0) + diff, reductions: list }));
}

function deactivateAbove(catId, amount) {
  const list = reductions().map((r) => r.catId === catId && amount > r.to ? { ...r, active: false } : r);
  return safeWrite(updateDoc(home, { reductions: list }));
}

function openBigMedal(medal, intro) {
  const rows = [[1, "בעוד שנה"], [5, "בעוד 5 שנים"], [10, "בעוד 10 שנים"], [18, "בעוד 18 שנים"]];
  openDialog(
    el("p", { class: "quiet", style: "text-align:center", text: intro || `מדליית השנה: ${medal.name}` }),
    el("div", { style: "align-self:center;width:190px;height:190px;border-radius:95px;border:6px solid #14213D;background:#FFB703;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 0 0 6px #FFFFFF inset" },
      el("span", { class: "display", style: "font-size:38px;line-height:1.1", text: money(medal.annual) }),
      el("strong", { text: "כל שנה" })),
    el("h2", { class: "display", style: "text-align:center", text: `זה אולי נראה כמו רק ${money(medal.monthly)}, אבל זה המון…` }),
    el("section", { class: "card", style: "background:#F1F4FB" }, el("h2", { text: "המתנה שלכם לילד" }),
      ...rows.map(([years, label], i) => el("div", { class: "row", style: i === 3 ? "font-weight:700;color:#1F4FD8;font-size:18px" : "" },
        el("span", { text: label }), el("strong", { text: money(medal.monthly * 12 * years) })))),
    el("p", { style: "text-align:center;font-weight:700;font-size:18px", text: "וזה עוד בלי הריבית!" }),
    el("button", { class: "primary", type: "button", text: "ממשיכים", onclick: closeDialog }));
}

// ---------- ladder ----------

const stationsList = () => state.household.stations || DEFAULT_STATIONS;

function monthsToReach(left) {
  const deposit = Number(state.household.deposit) || 0;
  if (!deposit || left <= 0) return "";
  const months = Math.ceil(left / deposit);
  return months <= 1 ? "בקצב של ההפקדה הקבועה: פחות מחודש" : `בקצב של ${money(deposit)} בחודש: כ-${months} חודשים`;
}

function viewLadder() {
  const total = savedTotal();
  const p = stationProgress(stationsList(), total);
  const nodes = [header("המסלול שלנו", `חסכתם מאז שהתחלנו ${money(total)}`, [el("button", { class: "pill line", type: "button", text: "עריכה", onclick: () => go("stations") })])];
  if (p.next) {
    nodes.push(el("section", { class: "hero", style: "gap:10px" },
      el("p", { class: "soft", text: "המטרה הקרובה" }),
      el("h2", { class: "display", style: "font-size:32px;color:#FFB703;line-height:1.2", text: p.next.name }),
      el("div", { class: "bar", style: "height:16px;border-radius:8px;background:#36466E" }, el("div", { style: `width:${p.pct}%;background:#FFB703;border-radius:8px` })),
      el("div", { style: "display:flex;justify-content:space-between;font-weight:700" }, el("span", { text: `עוד ${money(p.left)}` }), el("span", { text: `${Math.round(p.pct)}%` })),
      el("p", { class: "soft", text: monthsToReach(p.left) })));
  } else {
    nodes.push(el("section", { class: "hero" }, el("p", { class: "display big", text: "עברתם את כל התחנות!" }), el("p", { class: "soft", text: "הגיע הזמן להוסיף תחנה חדשה" })));
  }
  const upcoming = p.ahead.slice(1, 3).reverse();
  const hidden = Math.max(0, p.ahead.length - 3);
  const stop = (label, amount, kind) => {
    const styles = {
      next: "background:#FFB703;border:4px solid #14213D;width:64px;height:64px",
      locked: "background:#FFFFFF;border:3px solid #8290B3;width:44px;height:44px",
      done: "background:#14213D;border:3px solid #14213D;width:40px;height:40px;color:#FFB703"
    };
    return el("div", { style: `display:flex;align-items:center;gap:14px;${kind === "locked" ? "opacity:.85" : ""}` },
      el("span", { "aria-hidden": "true", style: `flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;${styles[kind]}`, text: kind === "done" ? "✓" : kind === "locked" ? "🔒" : "🎁" }),
      el("span", { class: "stack" }, el("strong", { style: kind === "next" ? "font-size:18px" : "", text: label }), el("span", { class: "small", text: money(amount) })));
  };
  const path = el("section", { class: "card", style: "gap:18px" });
  if (hidden) path.append(el("p", { class: "note", style: "align-self:center", text: `עוד ${hidden} תחנות מחכות בהמשך` }));
  upcoming.forEach((s, i) => path.append(el("div", { style: `padding-inline-start:${(upcoming.length - i) * 18}px` }, stop(s.name, s.amount, "locked"))));
  if (p.next) path.append(stop(p.next.name, p.next.amount, "next"));
  path.append(el("p", { style: "font-weight:700;color:#1F4FD8", text: `אתם כאן: ${money(total)}` }));
  p.reached.slice().reverse().forEach((s) => path.append(stop(s.name, s.amount, "done")));
  path.append(el("p", { class: "small", text: "נקודת הפתיחה · 0 ₪" }));
  nodes.push(path);
  const medals = yearMedals();
  if (medals.length) nodes.push(el("section", { class: "card" }, el("h2", { text: "מדליות השנה" }),
    ...medals.map((m) => el("button", { class: "row", type: "button", onclick: () => openBigMedal(m) }, el("strong", { text: m.name }), el("span", { text: `${money(m.annual)} כל שנה` })))));
  return nodes;
}

function viewStations() {
  const list = [...stationsList()].sort((a, b) => a.amount - b.amount);
  const total = savedTotal();
  const next = list.find((s) => s.amount > total);
  const save = (items) => safeWrite(updateDoc(home, { stations: items.sort((a, b) => a.amount - b.amount) }));
  const edit = (item, index) => {
    const amount = el("input", { id: "st-amount", class: "input", inputmode: "numeric", value: item ? item.amount : "" });
    const name = el("input", { id: "st-name", class: "input", value: item ? item.name : "", placeholder: "מה הכסף הזה יוכל לתת לילד?" });
    openDialog(el("h2", { text: item ? "עריכת תחנה" : "תחנה חדשה" }),
      el("div", { class: "field" }, el("label", { for: "st-amount", text: "סכום" }), amount),
      el("div", { class: "field" }, el("label", { for: "st-name", text: "שם התחנה" }), name),
      el("button", { class: "primary", type: "button", text: "שמירה", onclick: () => {
        const value = parseAmount(amount.value);
        if (!value || !name.value.trim()) return;
        const items = list.filter((_, i) => i !== index);
        items.push({ amount: value, name: name.value.trim() });
        closeDialog();
        save(items);
      } }),
      item && el("button", { class: "secondary", type: "button", text: "הסרת התחנה", onclick: () => { closeDialog(); save(list.filter((_, i) => i !== index)); } }),
      el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
  };
  return [header("עריכת המסלול", "התחנות מסתדרות לבד לפי הסכום", [el("button", { class: "pill", type: "button", text: "למסלול", onclick: () => go("ladder") })]),
    el("section", { class: "card list" }, ...list.map((s, i) => el("button", { class: "row", type: "button", onclick: () => edit(s, i) },
      el("strong", { style: "min-width:84px", text: money(s.amount) }),
      el("span", { class: "stack", style: "flex:1" }, el("span", { text: s.name }), s === next && el("span", { class: "small", style: "color:#1F4FD8;font-weight:700", text: "התחנה הבאה" }))))),
    el("button", { class: "dashed", type: "button", text: "תחנה חדשה", onclick: () => edit(null, -1) })];
}

// ---------- diary ----------

function monthLabel(id) {
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" }).format(cycleRange(id).start);
}

function viewDiary() {
  const closed = Object.entries(state.months).filter(([, m]) => m.closed).sort(([a], [b]) => (a < b ? 1 : -1));
  const gifts = closed.reduce((s, [, m]) => s + (m.closed.kid || 0), 0);
  const nodes = [header("יומן המתנות", ""),
    el("section", { class: "hero", style: "flex-direction:row;justify-content:space-between;align-items:center" },
      el("div", { class: "stack" }, el("p", { class: "soft", text: "עטפתם לילד עד היום" }), el("p", { class: "display big", style: "font-size:36px", text: money(gifts) })),
      el("strong", { text: `${closed.length} חודשים` }))];
  if (!closed.length) nodes.push(el("p", { class: "note", text: "החודש הראשון ייכנס ליומן אחרי הסגירה הראשונה." }));
  closed.forEach(([id, m]) => {
    const c = m.closed;
    const notes = Object.entries(c.notes || {}).filter(([, t]) => t);
    nodes.push(el("section", { class: "card", style: "gap:10px" },
      el("div", { class: "row" }, el("h2", { text: monthLabel(id) }), el("strong", { style: "font-size:18px", text: money(c.kid || 0) })),
      ...notes.map(([uid, text]) => el("p", { style: "line-height:1.45" }, el("strong", { text: `${memberName(uid)}: ` }), `״${text}״`)),
      (c.yearMedals?.length || c.medals?.length) ? el("div", { style: "display:flex;flex-wrap:wrap;gap:6px" },
        ...(c.yearMedals || []).map((y) => el("button", { type: "button", style: "padding:6px 12px;border:2px solid #14213D;border-radius:14px;background:#FFB703;font:inherit;font-size:14px;font-weight:700", text: `מדליית השנה: ${y.name}, ${money(y.annual)} כל שנה`, onclick: () => openBigMedal(y) })),
        ...(c.medals || []).map((x) => el("span", { style: "padding:4px 10px;border-radius:12px;background:#DDE3F2;font-size:13px;font-weight:500", text: `מדליה: ${x.name}` }))) : null,
      ...(c.stations || []).map((s) => el("p", { style: "padding:8px 12px;border-radius:12px;background:#FFB703;font-weight:700;font-size:14px", text: `הגעתם לתחנה: ${s.name}` })),
      !notes.length && el("button", { class: "secondary", style: "background:#F1F4FB", type: "button", text: "להוסיף משפט", onclick: () => { state.closeId = id; go("close"); } })));
  });
  return nodes;
}

// ---------- funds screen ----------

function viewFunds() {
  const list = fundsList();
  const inputs = list.map((f) => el("input", { id: `fund-${f.id}`, class: "input", style: "width:130px", inputmode: "numeric", value: f.balance ?? 0 }));
  const hint = (f) => f.kind === "safety" ? `ב-${money(SAFETY_TARGET)} עוברים ל-70/30` : f.kind === "vacation" ? `יעד ${money(6000)} · מלאה ב-${money(VACATION_FULL)}` : f.kind === "invest" ? "הסכום האמיתי בקופה" : "למעקב בלבד";
  const total = list.reduce((s, f) => s + (Number(f.balance) || 0), 0);
  const saveAll = () => {
    const next = list.map((f, i) => ({ ...f, balance: parseAmount(inputs[i].value), updatedAt: Date.now() }));
    safeWrite(updateDoc(home, { funds: next })).then(() => toast("נשמר"));
  };
  const add = () => {
    const name = el("input", { id: "new-fund", class: "input", placeholder: "למשל: קרן השתלמות, עו״ש" });
    const balance = el("input", { id: "new-fund-balance", class: "input", inputmode: "numeric", placeholder: "₪" });
    openDialog(el("h2", { text: "קופה חדשה" }),
      el("div", { class: "field" }, el("label", { for: "new-fund", text: "שם" }), name),
      el("div", { class: "field" }, el("label", { for: "new-fund-balance", text: "כמה יש בה עכשיו" }), balance),
      el("button", { class: "primary", type: "button", text: "הוספה", onclick: () => {
        if (!name.value.trim()) return;
        closeDialog();
        safeWrite(updateDoc(home, { funds: [...list, { id: `f${Date.now()}`, name: name.value.trim(), kind: "track", balance: parseAmount(balance.value), updatedAt: Date.now() }] }));
      } }),
      el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
  };
  return [header("הקופות שלנו", "סכומים אמיתיים, בלי השפעה על המסלול", [el("button", { class: "pill", type: "button", text: "להגדרות", onclick: () => go("settings") })]),
    el("p", { class: "note", text: "העברות שמסמנים במשימות בבנק מתעדכנות כאן לבד. אפשר לתקן לפי מה שרואים בבנק." }),
    el("section", { class: "card", style: "gap:14px" }, ...list.map((f, i) => el("div", { class: "row" },
      el("div", { class: "stack" }, el("label", { for: `fund-${f.id}`, style: "font-weight:700", text: f.name }), el("span", { class: "small", text: hint(f) })), inputs[i])),
      el("div", { class: "row", style: "padding-top:12px;border-top:2px solid #14213D;font-weight:700;font-size:18px" }, el("span", { text: "סך הכול" }), el("span", { text: money(total) }))),
    el("button", { class: "dashed", type: "button", text: "קופה חדשה, כמו גמל, השתלמות או פנסיה", onclick: add }),
    el("button", { class: "primary", type: "button", text: "שמירה", onclick: saveAll })];
}

// ---------- insights ----------

function closedHistory() {
  return Object.entries(state.months).filter(([, m]) => m.closed?.lines).sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([id, m]) => ({ id, lines: m.closed.lines }));
}

function viewInsights() {
  const history = closedHistory();
  const recs = insights(history, state.categories, { snoozed: state.household.snoozed || {}, currentId: state.cycleId });
  const nodes = [header("תובנות והמלצות", history.length ? `לפי ${Math.min(6, history.length)} החודשים האחרונים` : "")];
  if (history.length < 3) nodes.push(el("p", { class: "note", text: `ההמלצות מתחילות אחרי 3 חודשים סגורים. עד עכשיו נסגרו ${history.length}.` }));
  else if (!recs.length) nodes.push(el("p", { class: "note", text: "כרגע אין דפוס קבוע שמצדיק שינוי. כל הכבוד!" }));
  recs.forEach((rec) => {
    const cat = rec.category;
    const reduce = rec.kind === "reduce";
    const planned = plannedTotal(state.categories, state.household.deposit);
    const fits = reduce || planned + rec.diff <= state.household.income;
    const why = () => openDialog(el("h2", { text: `למה ${cat.name}?` }),
      el("p", { text: `התקציב ${money(rec.from)}. ב-${rec.count} מתוך ${rec.months} החודשים האחרונים ${reduce ? "נשאר כסף" : "הייתה חריגה"}.` }),
      el("div", { class: "list" }, ...rec.history.map((h) => el("div", { class: "row" }, el("span", { text: monthLabel(h.id) }), el("strong", { text: money(h.spent) })))),
      el("button", { class: "secondary", type: "button", text: "סגירה", onclick: closeDialog }));
    const dismiss = () => openDialog(el("h2", { text: "למה לא עכשיו?" }),
      ...["חודש חריג", "זה עומד להשתנות", "סתם לא מתאים"].map((reason) => el("button", { class: "option", type: "button", text: reason, onclick: () => {
        closeDialog();
        safeWrite(updateDoc(home, { snoozed: { ...(state.household.snoozed || {}), [cat.id]: shiftCycle(state.cycleId, 3) } }));
        toast("לא נציע את זה ב-3 החודשים הקרובים");
      } })),
      el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
    const approve = async () => {
      if (reduce) {
        await moveToChild(cat, rec.diff, rec.to);
        toast(`מהחודש הבא עוד ${money(rec.diff)} לילד בכל חודש`);
      } else {
        await safeWrite(updateDoc(doc(col("categories"), cat.id), { amount: rec.to }));
        await deactivateAbove(cat.id, rec.to);
        toast("התקציב יתעדכן מהחודש הבא");
      }
      safeWrite(updateDoc(home, { snoozed: { ...(state.household.snoozed || {}), [cat.id]: shiftCycle(state.cycleId, 3) } }));
    };
    nodes.push(el("section", { class: reduce ? "hero" : "card", style: "gap:10px" },
      reduce && el("p", { style: "color:#FFB703;font-weight:700", text: "עוד שקל לילד" }),
      el("h2", { style: "font-size:20px;line-height:1.3", text: reduce ? `ב${cat.name} נשארים לכם בקביעות כסף` : `ב${cat.name} אתם חורגים בקביעות` }),
      el("p", { class: reduce ? "soft" : "quiet", style: "line-height:1.45", text: reduce
        ? `להעביר לילד עוד ${money(rec.diff)} בחודש מתקציב ה${cat.name}? זה ${money(rec.annual)} בשנה.`
        : `להגדיל את התקציב ל-${money(rec.to)} כדי שיתאים למציאות?${fits ? "" : " צריך קודם לפנות מקום בתקציב אחר."}` }),
      el("div", { style: "display:flex;gap:8px" },
        el("button", { class: "primary", style: "min-height:48px;font-size:16px", type: "button", disabled: !fits, text: reduce ? "מעבירים לילד" : "מאשרים", onclick: approve }),
        el("button", { class: "secondary", style: "min-height:48px", type: "button", text: "לא עכשיו", onclick: dismiss })),
      el("button", { type: "button", style: `border:0;background:transparent;font:inherit;text-decoration:underline;color:${reduce ? "#D7DFF2" : "#46516F"}`, text: "למה?", onclick: why })));
  });
  const averages = categoryAverages(history, state.categories);
  if (averages.length) nodes.push(el("section", { class: "card" }, el("h2", { text: "חציון חודשי מול התקציב" }),
    ...averages.map((a) => {
      const diff = a.category.amount - a.median;
      return el("div", { class: "row" }, el("span", { style: "font-weight:500", text: a.category.name }),
        el("span", { style: diff < 0 ? "font-weight:700" : "", text: `${money(a.median)} מתוך ${money(a.category.amount)} · ${diff >= 0 ? `נשאר ${money(diff)}` : `חריגה ${money(-diff)}`}` }));
    })));
  return nodes;
}

// ---------- weekly story ----------

function storyData() {
  const summary = currentSummary();
  const progress = cycleProgress(state.cycleId, new Date());
  const ratio = progress.elapsed / progress.total;
  const ongoing = summary.flexible.filter((l) => l.type === "ongoing" && l.available > 0);
  const wins = ongoing.map((l) => ({ line: l, ahead: Math.round(l.available * ratio - l.spent) })).sort((a, b) => b.ahead - a.ahead);
  const win = wins[0] && wins[0].ahead > 0 ? wins[0] : null;
  const risky = ongoing.map((l) => ({ line: l, projected: progress.elapsed ? (l.spent / progress.elapsed) * progress.total : 0 }))
    .sort((a, b) => (b.projected - b.line.available) - (a.projected - a.line.available))[0];
  let challenge = null;
  if (risky) {
    const gap = Math.round(risky.projected - risky.line.available);
    const amount = gap > 0 ? Math.max(30, Math.ceil(gap / 10) * 10) : Math.max(30, Math.round(risky.line.available * 0.05 / 10) * 10);
    challenge = { name: risky.line.name, amount, medal: gap > 0 };
  }
  const p = stationProgress(stationsList(), savedTotal());
  const missing = summary.flexible.filter((l) => l.type === "bill" && l.spent === 0).length;
  return { summary, progress, predicted: forecast(summary, progress), win, challenge, station: p, missing, overs: summary.overspends.length };
}

function viewStory() {
  const d = storyData();
  const names = Object.values(state.household.members || {}).join(" ו");
  const slides = [
    { bg: "#14213D", fg: "#FFFFFF", body: [el("div", { class: "pop" }, el("div", { class: "bob", style: "font-size:96px", text: "🎁" })),
      el("h1", { class: "display rise2", style: "font-size:36px", text: `בוקר טוב, ${names}!` }), el("p", { class: "rise3", style: "font-size:19px", text: "בואו נראה מה עשיתם השבוע" })] },
    { bg: "#FFB703", fg: "#14213D", body: d.win
      ? [el("p", { class: "rise", style: "font-size:19px;font-weight:500", text: "הניצחון של השבוע" }), el("div", { class: "pop bob", style: "font-size:84px", text: "🪙" }),
        el("h1", { class: "display rise2", style: "font-size:50px", text: `${money(d.win.ahead)} פחות` }), el("p", { class: "rise3", style: "font-size:19px", text: `על ${d.win.line.name}, לעומת הקצב המתוכנן` })]
      : [el("p", { class: "rise", style: "font-size:19px;font-weight:500", text: "השבוע הזה" }), el("h1", { class: "display pop", style: "font-size:40px", text: "כל שבוע הוא התחלה חדשה" }),
        el("p", { class: "rise2", style: "font-size:19px", text: `נשארו ${d.progress.left} ימים, ועדיין אפשר לשנות כיוון` })] },
    { bg: "#1F4FD8", fg: "#FFFFFF", body: [el("p", { class: "rise", style: "font-size:19px;font-weight:500", text: "עוד אפשר לחסוך החודש" }),
      el("h1", { class: "display pop", style: "font-size:56px", text: `עד ${money(d.summary.canSave)}` }),
      el("p", { class: "rise2", style: "font-size:19px", text: d.predicted ? `ובקצב הנוכחי, כ-${money(Math.round(d.predicted * (savedSplit())))} בדרך לילד` : `נשארו ${d.progress.left} ימים` })] },
    { bg: "#14213D", fg: "#FFFFFF", body: d.station.next
      ? [el("p", { class: "rise", style: "font-size:19px;font-weight:500", text: "התחנה הקרובה" }), el("h1", { class: "display rise2", style: "font-size:34px;color:#FFB703", text: d.station.next.name }),
        el("div", { style: "width:100%;height:22px;border-radius:11px;background:#36466E;overflow:hidden" }, el("div", { class: "grow", style: `height:100%;border-radius:11px;background:#FFB703;--w:${d.station.pct}%` })),
        el("p", { class: "rise3", style: "font-size:22px;font-weight:700", text: `עוד ${money(d.station.left)} ואתם שם!` })]
      : [el("h1", { class: "display pop", style: "font-size:40px", text: "עברתם את כל התחנות!" })] },
    { bg: "#FFB703", fg: "#14213D", body: d.challenge
      ? [el("p", { class: "rise", style: "font-size:19px;font-weight:500", text: "האתגר לשבוע הבא" }), el("h1", { class: "display pop", style: "font-size:40px", text: `עוד ${money(d.challenge.amount)} פחות על ${d.challenge.name}` }),
        el("p", { class: "rise2", style: "font-size:20px", text: d.challenge.medal ? "וזה שומר על מדליית החודש" : "ומדליית החודש שלכם" })]
      : [el("h1", { class: "display pop", style: "font-size:40px", text: "ממשיכים ככה!" })] },
    { bg: "#1F4FD8", fg: "#FFFFFF", last: true, body: [el("h1", { class: "display pop", style: "font-size:42px", text: "שבת שלום!" }),
      el("p", { class: "rise2", style: "font-size:19px", text: "עוד שבוע טוב בדרך, עוד שקל לילד" })] }
  ];
  const i = Math.min(state.storyIndex || 0, slides.length - 1);
  const slide = slides[i];
  const extra = [];
  if (slide.last) {
    if (d.missing) extra.push(el("button", { class: "primary", type: "button", text: `${d.missing} חשבונות מחכים לסכום`, onclick: () => { state.storyIndex = 0; go("expenses", "bill"); } }));
    if (d.overs) extra.push(el("button", { class: "primary", type: "button", text: "יש חריגה שמחכה לכיסוי", onclick: () => { state.storyIndex = 0; go("home"); } }));
    extra.push(el("button", { class: "secondary", type: "button", text: "למסך הראשי", onclick: () => { state.storyIndex = 0; go("home"); } }));
  }
  const move = (delta) => { state.storyIndex = Math.max(0, Math.min(slides.length - 1, i + delta)); render(); };
  return [el("div", { class: "story", style: `background:${slide.bg};color:${slide.fg}` },
    el("div", { class: "story-bars", "aria-hidden": "true" }, ...slides.map((_, n) => el("span", { style: `background:${slide.fg};opacity:${n <= i ? 1 : 0.3}` }))),
    el("div", { class: "story-body" }, ...slide.body),
    el("div", { class: "story-actions" }, ...extra, !slide.last && el("p", { style: "text-align:center;font-weight:500;font-size:14px", text: "הקישו להמשך" })),
    el("button", { class: "story-tap prev", type: "button", "aria-label": "הקודם", onclick: () => move(-1) }),
    !slide.last && el("button", { class: "story-tap next", type: "button", "aria-label": "הבא", onclick: () => move(1) }),
    el("button", { class: "story-close", type: "button", "aria-label": "סגירה", text: "✕", onclick: () => { state.storyIndex = 0; go("home"); } }))];
}

const savedSplit = () => ((Number(fundOf("safety")?.balance) || 0) >= SAFETY_TARGET ? 0.7 : 0.5);

// ---------- notifications and export ----------

// Public key from Firebase: Project settings > Cloud Messaging > Web Push certificates.
const VAPID_KEY = "BBwZ1nm72XxByf92IqBFv0nKebeVtlzRPCAFVtUPZaNiRUGhwiCOIuf1zgCytSSx0HpJfpQ_RMpLVFIi8Qsdqys";

async function enableNotifications() {
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { toast("פתחו את האפליקציה מהסמל במסך הבית כדי לאשר התראות"); return; }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { toast("ההתראות לא אושרו. אפשר לאשר בהגדרות האייפון."); return; }
    if (!VAPID_KEY) { toast("ההתראות אושרו. חסר עוד מפתח אחד כדי לחבר אותן לשרת."); return; }
    const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging.js");
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    await safeWrite(setDoc(doc(col("devices"), token.slice(-40)), { token, uid: state.user.uid, at: Date.now(), agent: navigator.userAgent.slice(0, 120) }));
    toast("ההתראות מחוברות לטלפון הזה");
  } catch (err) {
    toast(`חיבור ההתראות נכשל: ${err.code || err.message}`);
  }
}

async function exportData() {
  const out = { exportedAt: new Date().toISOString(), household: state.household };
  for (const name of ["categories", "months", "expenses", "covers"]) {
    const snap = await getDocs(col(name));
    out[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const file = new File([blob], `od-shekel-${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: "גיבוי עוד שקל לילד" }).catch(() => {});
    return;
  }
  const link = el("a", { href: URL.createObjectURL(blob), download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
}

async function testNotification() {
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      toast("הדפדפן הזה לא תומך בהתראות. פתחו מהסמל במסך הבית.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("ההתראות לא אושרו. אפשר לאשר בהגדרות האייפון.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const show = (body) => registration.showNotification("עוד שקל לילד", { body, icon: "icon-192.png", badge: "icon-192.png", tag: `test-${Date.now()}` });
    await show("הסיכום השבועי שלכם מחכה");
    toast("נשלחה התראה. עוד אחת תגיע בעוד 6 שניות.");
    setTimeout(() => show("חסר חשבון אחד לסגירת החודש"), 6000);
  } catch (err) {
    toast(`ההתראה נכשלה: ${err.message}`);
  }
}

function viewSettings() {
  const h = state.household;
  const income = el("input", { id: "income", class: "input", inputmode: "numeric", value: state.month?.income ?? h.income });
  const deposit = el("input", { id: "deposit", class: "input", inputmode: "numeric", value: h.deposit });
  const error = el("p", { class: "note", hidden: true, role: "alert" });
  const save = async () => {
    const nextIncome = parseAmount(income.value);
    const nextDeposit = parseAmount(deposit.value);
    const planned = plannedTotal(state.categories, nextDeposit);
    if (planned > nextIncome) {
      error.textContent = `התכנון עובר את ההכנסות ב-${money(planned - nextIncome)}. הורידו קודם מסעיף אחר.`;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    await safeWrite(updateDoc(home, { income: nextIncome, deposit: nextDeposit }));
    const update = { income: nextIncome };
    if (isTrial(new Date())) update.deposit = nextDeposit;
    await safeWrite(updateDoc(doc(home, "months", state.cycleId), update));
    toast("נשמר");
  };
  const nodes = [header("הגדרות", memberName(state.user.uid)),
    el("section", { class: "card" }, el("h2", { text: "הכסף של החודש" }),
      el("div", { class: "field" }, el("label", { for: "income", text: "הכנסה בחודש הזה" }), income),
      el("div", { class: "field" }, el("label", { for: "deposit", text: "הפקדה קבועה לילד" }), deposit), error,
      el("button", { class: "primary", type: "button", text: "שמירה", onclick: save })),
    el("button", { class: "secondary", type: "button", text: "משימות בבנק", onclick: () => go("bank") }),
    el("button", { class: "secondary", type: "button", text: "הקופות שלנו", onclick: () => go("funds") }),
    el("button", { class: "secondary", type: "button", text: "יומן המתנות", onclick: () => go("diary") }),
    el("button", { class: "secondary", type: "button", text: "תובנות והמלצות", onclick: () => go("insights") }),
    el("button", { class: "secondary", type: "button", text: "הסיכום השבועי", onclick: () => { state.storyIndex = 0; go("story"); } }),
    el("button", { class: "secondary", type: "button", text: "עריכת הוצאות וקטגוריות", onclick: () => go("categories") })];
  if (isTrial(new Date())) nodes.push(el("button", { class: "secondary", type: "button", text: "איפוס נתוני הניסיון", onclick: askReset }));
  nodes.push(el("button", { class: "secondary", type: "button", text: "הפעלת התראות בטלפון הזה", onclick: enableNotifications }));
  nodes.push(el("button", { class: "secondary", type: "button", text: "שליחת התראת בדיקה", onclick: testNotification }));
  nodes.push(el("button", { class: "secondary", type: "button", text: "ייצוא גיבוי של כל הנתונים", onclick: exportData }));
  nodes.push(el("button", { class: "secondary", type: "button", text: "התנתקות", onclick: () => signOut(auth) }));
  return nodes;
}

function askReset() {
  openDialog(el("h2", { text: "לאפס את נתוני הניסיון?" }), el("p", { text: "כל ההוצאות והכיסויים שהוזנו עד עכשיו יימחקו. הקטגוריות נשארות." }),
    el("button", { class: "primary", type: "button", text: "איפוס", onclick: async () => {
      closeDialog();
      const batch = writeBatch(db);
      for (const name of ["expenses", "covers"]) {
        const snap = await getDocs(query(col(name), where("monthId", "==", state.cycleId)));
        snap.docs.forEach((d) => batch.delete(d.ref));
      }
      await safeWrite(batch.commit());
      toast("הנתונים אופסו");
    } }),
    el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
}

function viewSetup() {
  const area = el("textarea", { id: "seed", class: "input", dir: "ltr", spellcheck: "false", "aria-label": "נתוני פתיחה" });
  const error = el("p", { class: "note", hidden: true, role: "alert" });
  const run = async () => {
    try {
      const seed = JSON.parse(area.value);
      const batch = writeBatch(db);
      batch.set(home, { income: seed.income, deposit: seed.deposit, members: seed.members, createdAt: serverTimestamp() });
      seed.categories.forEach((c, index) => batch.set(doc(col("categories")), { name: c.name, type: c.type, amount: c.amount, freq: c.freq || "month", order: index }));
      await batch.commit();
    } catch (err) {
      error.textContent = `לא הצלחתי לקרוא את הנתונים: ${err.code || err.message}`;
      error.hidden = false;
    }
  };
  return [header("הגדרה ראשונה", "פעם אחת בלבד"), el("section", { class: "card" },
    el("p", { text: "הדביקו כאן את נתוני הפתיחה." }), area, error, el("button", { class: "primary", type: "button", text: "יוצרים", onclick: run }))];
}

function viewLogin() {
  const email = el("input", { id: "email", class: "input", type: "email", autocomplete: "username", inputmode: "email", dir: "ltr", required: true });
  const password = el("input", { id: "password", class: "input", type: "password", autocomplete: "current-password", dir: "ltr", required: true });
  const error = el("p", { class: "note", hidden: true, role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: "כניסה" });
  const form = el("form", { class: "card", onsubmit: async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
    } catch (err) {
      error.textContent = err.code === "auth/invalid-credential" ? "המייל או הסיסמה לא נכונים" : `הכניסה נכשלה: ${err.code || err.message}`;
      error.hidden = false;
      submit.disabled = false;
    }
  } }, el("div", { class: "field" }, el("label", { for: "email", text: "מייל" }), email),
  el("div", { class: "field" }, el("label", { for: "password", text: "סיסמה" }), password), error, submit);
  return [el("h1", { class: "display", style: "font-size:34px;text-align:center", text: "עוד שקל לילד" }), form];
}

function renderNav(visible) {
  const nav = document.getElementById("nav");
  nav.hidden = !visible;
  if (!visible) return;
  const items = [["home", "בית"], ["expenses", "הוצאות"], ["ladder", "מסלול"], ["settings", "עוד"]];
  nav.firstElementChild.replaceChildren(...items.map(([key, label]) => el("button", {
    type: "button", text: label, class: state.view === key || (key === "expenses" && state.view === "categories") || (key === "ladder" && state.view === "stations") || (key === "settings" && ["bank", "funds", "diary", "insights", "close"].includes(state.view)) ? "on" : "",
    onclick: () => go(key)
  })));
}

function preserveFocus(run) {
  const active = document.activeElement;
  if (active && active.id && active.matches("input, textarea")) {
    state.draftAmount = document.getElementById("amount")?.value ?? state.draftAmount;
    state.draftNote = document.getElementById("note")?.value ?? state.draftNote;
    const id = active.id;
    run();
    document.getElementById(id)?.focus();
    return;
  }
  if (document.getElementById("amount")) {
    state.draftAmount = document.getElementById("amount").value;
    state.draftNote = document.getElementById("note").value;
  }
  run();
}

function render() {
  const root = document.getElementById("app");
  const show = (nodes, center, nav) => {
    root.className = center ? "center" : "";
    preserveFocus(() => root.replaceChildren(...nodes));
    renderNav(nav);
  };
  if (state.user === null) return show(viewLogin(), true, false);
  if (state.loadError) return show([el("section", { class: "card" }, el("p", { text: "אין גישה לנתונים." }), el("p", { class: "error", text: state.loadError }), el("button", { class: "secondary", type: "button", text: "התנתקות", onclick: () => signOut(auth) })) ], true, false);
  if (state.household === undefined) return show([el("p", { class: "quiet", text: "טוען…" })], true, false);
  if (state.household === null) return show(viewSetup(), false, false);
  if (!state.month) return show([el("p", { class: "quiet", text: "מכין את החודש…" })], true, false);
  const views = { home: viewHome, expenses: viewExpenses, categories: viewCategories, settings: viewSettings, bank: viewBank, close: viewClose,
    ladder: viewLadder, stations: viewStations, diary: viewDiary, funds: viewFunds, insights: viewInsights, story: viewStory };
  show(views[state.view](), false, state.view !== "story");
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) checkCycle(); });
setInterval(checkCycle, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.loadError = null;
  state.household = undefined;
  state.months = {};
  state.monthsLoaded = false;
  state.month = undefined;
  if (user) listen(); else stopListening();
  render();
});
