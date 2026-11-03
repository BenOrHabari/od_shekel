import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, doc, collection, setDoc, updateDoc, deleteDoc,
  addDoc, onSnapshot, query, where, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import {
  cycleIdOf, cycleRange, cycleProgress, isTrial, summarize, forecast, coverOptions, plannedTotal, money
} from "./logic.js?v=2";

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
  user: null, household: undefined, categories: [], month: undefined, expenses: [], covers: [],
  view: "home", tab: "ongoing", pickedCategory: null, cycleId: cycleIdOf(new Date())
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

function listen() {
  stopListening();
  const id = state.cycleId;
  const onError = (err) => { state.loadError = err.code || err.message; render(); };
  unsubscribers.push(onSnapshot(home, (snap) => {
    state.household = snap.exists() ? snap.data() : null;
    ensureMonth();
    render();
  }, onError));
  unsubscribers.push(onSnapshot(col("categories"), (snap) => {
    state.categories = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.archived)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    ensureMonth();
    render();
  }, onError));
  unsubscribers.push(onSnapshot(doc(home, "months", id), (snap) => {
    state.month = snap.exists() ? snap.data() : null;
    ensureMonth();
    render();
  }, onError));
  unsubscribers.push(onSnapshot(query(col("expenses"), where("monthId", "==", id)), (snap) => {
    state.expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.spentAt || 0) - (a.spentAt || 0));
    render();
  }, onError));
  unsubscribers.push(onSnapshot(query(col("covers"), where("monthId", "==", id)), (snap) => {
    state.covers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, onError));
}

const snapshotBudgets = () => state.categories.map(({ id, name, type, amount, freq }) => ({ id, name, type, amount, freq: freq || "month" }));

function ensureMonth() {
  if (state.month !== null || !state.household || !state.categories.length) return;
  safeWrite(setDoc(doc(home, "months", state.cycleId), {
    budgets: snapshotBudgets(), income: state.household.income, deposit: state.household.deposit, createdAt: serverTimestamp()
  }));
}

const memberName = (uid) => state.household?.members?.[uid] || "";
const partnerUid = () => Object.keys(state.household?.members || {}).find((uid) => uid !== state.user.uid);

function currentSummary() {
  const month = state.month;
  return summarize({
    budgets: month.budgets, expenses: state.expenses, covers: state.covers, income: month.income, deposit: month.deposit
  });
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

  if (isTrial(now)) nodes.push(el("p", { class: "note", text: "זו תקופת ניסיון. המחזור הראשון מתחיל ב-15 בנובמבר, ולפניו אפשר לאפס את הנתונים בהגדרות." }));

  summary.overspends.forEach((line) => nodes.push(el("button", {
    class: "alert", type: "button", onclick: () => openCover(line.id)
  }, el("span", { text: `חריגה של ${money(line.over)} ב${line.name}` }), el("span", { text: "לכיסוי" }))));

  nodes.push(el("section", { class: "hero" },
    el("p", { class: "soft", text: "עוד אפשר לחסוך החודש" }),
    el("p", { class: "display big", text: `עד ${money(summary.canSave)}` }),
    el("p", { class: "soft", text: predicted === null ? "התחזית תופיע אחרי כמה ימים" : predicted > 0 ? `בקצב הנוכחי תחסכו כ-${money(predicted)}` : `נשארו ${progress.left} ימים, עדיין אפשר לשנות כיוון` })));

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

  nodes.push(el("button", { class: "primary", type: "button", text: "הוספת הוצאה", onclick: () => go("expenses", "ongoing") }));
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
  const fixed = summary.lines.filter((l) => l.type === "fixed");
  const total = fixed.reduce((s, l) => s + l.spent, 0);
  return [
    el("p", { class: "quiet", text: "יורדות לבד כל חודש, עד שתשנו אותן" }),
    el("section", { class: "card list" }, ...fixed.map((line) => el("div", { class: "row" }, el("span", { text: line.name }), el("span", { text: money(line.amount) })))),
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

function openCover(lineId, overOverride) {
  const summary = currentSummary();
  const line = summary.lines.find((l) => l.id === lineId);
  const over = Math.max(line.over, overOverride || 0);
  const options = coverOptions(summary, lineId);
  let chosen = null;
  const buttons = options.map((option) => {
    const after = Math.max(0, option.left - over);
    return el("button", { class: "option", type: "button", "data-id": option.id, onclick: (event) => {
      chosen = option;
      buttons.forEach((b) => b.classList.toggle("on", b === event.currentTarget));
      confirm.disabled = false;
    } }, el("span", { class: "stack" }, el("strong", { text: option.name }),
      el("span", { class: "small", text: option.left >= over ? `יישארו ${money(after)} מתוך ${money(option.left)}` : `יש כאן רק ${money(option.left)}, ואז נכסה את השאר` })));
  });
  const confirm = el("button", { class: "primary", type: "button", disabled: true, text: "מכסים עכשיו", onclick: async () => {
    const amount = Math.min(over, chosen.left);
    await safeWrite(addDoc(col("covers"), {
      monthId: state.cycleId, fromId: chosen.id, fromName: chosen.name, toId: lineId, amount, by: state.user.uid, createdAt: serverTimestamp()
    }));
    if (over - amount > 0) { setTimeout(() => openCover(lineId, over - amount), 300); return; }
    shareCover(line.name, over, chosen.name);
  } });
  const empty = options.length === 0;
  openDialog(el("h2", { class: "display", text: `חרגתם מ${line.name} ב-${money(over)}` }),
    el("p", { text: empty ? "אין יותר מאיפה לכסות בתקציבים. בקרוב האפליקציה תציע להוריד מההפקדות." : "מאיפה נכסה את זה?" }),
    ...buttons, !empty && el("p", { class: "small", text: "הסעיף שתבחרו לא יקבל מדליה החודש" }), !empty && confirm,
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
  const name = el("input", { id: "cat-name", class: "input", value: item.name, placeholder: "שם" });
  const amount = el("input", { id: "cat-amount", class: "input", inputmode: "numeric", value: item.amount || "", placeholder: "₪" });
  const error = el("p", { class: "note", hidden: true, role: "alert" });
  const typeTabs = el("div", { class: "tabs" });
  const freqTabs = el("div", { class: "tabs", style: "grid-template-columns:repeat(2,minmax(0,1fr))" });
  const paint = () => {
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
    const data = { name: cleanName, amount: value, type, freq: type === "bill" ? freq : "month" };
    closeDialog();
    if (item.isNew) await safeWrite(addDoc(col("categories"), { ...data, order: Date.now() }));
    else await safeWrite(updateDoc(doc(col("categories"), item.id), data));
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
    el("div", { class: "field" }, el("label", { for: "cat-amount", text: "סכום ממוצע לחודש" }), amount), freqTabs, error,
    el("button", { class: "primary", type: "button", text: "שמירה", onclick: save }),
    !item.isNew && el("button", { class: "secondary", type: "button", text: "הסרה", onclick: remove }),
    el("button", { class: "secondary", type: "button", text: "ביטול", onclick: closeDialog }));
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
    el("button", { class: "secondary", type: "button", text: "עריכת הוצאות וקטגוריות", onclick: () => go("categories") })];
  if (isTrial(new Date())) nodes.push(el("button", { class: "secondary", type: "button", text: "איפוס נתוני הניסיון", onclick: askReset }));
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
  const items = [["home", "בית"], ["expenses", "הוצאות"], ["settings", "הגדרות"]];
  nav.firstElementChild.replaceChildren(...items.map(([key, label]) => el("button", {
    type: "button", text: label, class: state.view === key || (key === "expenses" && state.view === "categories") ? "on" : "",
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
  const views = { home: viewHome, expenses: viewExpenses, categories: viewCategories, settings: viewSettings };
  show(views[state.view](), false, true);
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.loadError = null;
  state.household = undefined;
  state.month = undefined;
  if (user) listen(); else stopListening();
  render();
});
