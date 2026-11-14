// Pure budget calculations. No Firebase and no personal numbers here.

export const CYCLE_DAY = 15;
export const FIRST_CYCLE = "2026-11";

const pad = (n) => String(n).padStart(2, "0");

export function cycleIdOf(date) {
  let year = date.getFullYear();
  let month = date.getMonth();
  if (date.getDate() < CYCLE_DAY) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  const id = `${year}-${pad(month + 1)}`;
  return id < FIRST_CYCLE ? FIRST_CYCLE : id;
}

export function cycleRange(id) {
  const [year, month] = id.split("-").map(Number);
  return { start: new Date(year, month - 1, CYCLE_DAY), end: new Date(year, month, CYCLE_DAY - 1) };
}

export function shiftCycle(id, delta) {
  const [year, month] = id.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function isTrial(date) {
  return date < cycleRange(FIRST_CYCLE).start;
}

const DAY = 24 * 60 * 60 * 1000;

export function cycleProgress(id, now) {
  const { start, end } = cycleRange(id);
  const total = Math.round((end - start) / DAY) + 1;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const elapsed = Math.min(total, Math.max(0, Math.round((today - start) / DAY) + 1));
  return { total, elapsed, left: Math.max(0, total - elapsed) };
}

export function plannedTotal(budgets, deposit) {
  return budgets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0) + (Number(deposit) || 0);
}

export function summarize({ budgets, expenses, covers, income, deposit, carry = {} }) {
  const lines = budgets.map((budget) => {
    const spent = budget.type === "fixed"
      ? Number(budget.amount) || 0
      : expenses.filter((e) => e.categoryId === budget.id).reduce((s, e) => s + e.amount, 0);
    const coverIn = covers.filter((c) => c.toId === budget.id).reduce((s, c) => s + c.amount, 0);
    const coverOut = covers.filter((c) => c.fromId === budget.id).reduce((s, c) => s + c.amount, 0);
    // A bi-monthly bill that did not arrive last month brings its budget along.
    const base = (Number(budget.amount) || 0) + (budget.type === "bill" ? Number(carry[budget.id]) || 0 : 0);
    const available = base + coverIn - coverOut;
    return {
      ...budget,
      base,
      spent,
      coverIn,
      coverOut,
      available,
      left: Math.max(0, available - spent),
      over: Math.max(0, spent - available)
    };
  });

  const planned = plannedTotal(budgets, deposit);
  const marginPlanned = Math.max(0, (Number(income) || 0) - planned);
  const marginUsed = covers.filter((c) => c.fromId === "margin").reduce((s, c) => s + c.amount, 0);
  const marginLeft = Math.max(0, marginPlanned - marginUsed);

  const flexible = lines.filter((l) => l.type !== "fixed");
  const overspends = flexible.filter((l) => l.over > 0);
  const openOver = overspends.reduce((s, l) => s + l.over, 0);
  // A bill with no amount yet is assumed to arrive in full, so it cannot be saved.
  const saveable = flexible.reduce((s, l) => s + (l.type === "bill" && l.spent === 0 ? 0 : l.left), 0);
  const canSave = Math.max(0, saveable + marginLeft - openOver);

  return { lines, flexible, overspends, openOver, planned, marginPlanned, marginLeft, canSave };
}

export function forecast(summary, progress) {
  if (progress.elapsed < 3) return null;
  const projected = summary.flexible.reduce((sum, line) => {
    if (line.type !== "ongoing") return line.spent === 0 ? sum : sum + Math.max(0, line.available - line.spent);
    const pace = (line.spent / progress.elapsed) * progress.total;
    return sum + (line.available - pace);
  }, 0);
  return Math.max(0, Math.round(projected + summary.marginLeft - summary.openOver));
}

export function coverOptions(summary, targetId) {
  const options = [];
  if (summary.marginLeft > 0) {
    options.push({ id: "margin", name: "מרווח הטעות", left: summary.marginLeft });
  }
  summary.flexible
    .filter((l) => l.id !== targetId && l.left > 0 && !(l.type === "bill" && l.spent === 0))
    .sort((a, b) => b.left - a.left)
    .forEach((l) => options.push({ id: l.id, name: l.name, left: l.left }));
  return options;
}

export const SAFETY_TARGET = 15000;

const notArrived = (line) => line.type === "bill" && line.spent === 0;

export function unpaidBills(summary) {
  const out = {};
  summary.flexible.filter((l) => notArrived(l) && l.freq === "two").forEach((l) => { out[l.id] = l.base; });
  return out;
}

export function closeResult(summary, safetyBalance) {
  const counted = summary.flexible.filter((l) => !notArrived(l));
  const leftover = Math.max(0, counted.reduce((s, l) => s + l.left, 0) + summary.marginLeft - summary.openOver);
  const kidRatio = (Number(safetyBalance) || 0) >= SAFETY_TARGET ? 0.7 : 0.5;
  const kid = Math.round(leftover * kidRatio);
  const medals = counted
    .filter((l) => l.left > 0 && l.over === 0 && l.coverIn === 0 && l.coverOut === 0)
    .map((l) => ({ id: l.id, name: l.name, saved: l.left }));
  return { leftover, kid, safety: leftover - kid, kidRatio, medals, unpaid: unpaidBills(summary) };
}

export const VACATION_FULL = 8000;

export function bankTasks(month, prevResult, funds = []) {
  const kid = prevResult ? prevResult.kid : 0;
  const deposit = Number(month.deposit) || 0;
  const vacation = funds.find((f) => f.kind === "vacation");
  const vacationFull = vacation && (Number(vacation.balance) || 0) >= VACATION_FULL;
  const tasks = [];
  let redirected = 0;
  month.budgets.filter((b) => b.type === "fixed" && fixedGroupOf(b) === "קופות").forEach((b) => {
    const amount = Number(b.amount) || 0;
    if (vacationFull && /חופש/.test(b.name)) { redirected += amount; return; }
    tasks.push({ id: `fund-${b.id}`, label: `ל${b.name}`, detail: "העברה חודשית", amount, fundKind: /חופש/.test(b.name) ? "vacation" : "" });
  });
  const parts = [`${money(deposit)} הפקדה`];
  if (kid) parts.push(`${money(kid)} מתנה מהחודש הקודם`);
  if (redirected) parts.push(`${money(redirected)} מקופת החופשות המלאה`);
  tasks.unshift({ id: "invest", label: "לקופת ההשקעה", kid, redirected, detail: parts.join(", "), amount: deposit + kid + redirected, fundKind: "invest" });
  if (prevResult && prevResult.safety > 0) {
    tasks.push({ id: "safety", label: "לקופת הביטחון", detail: "החלק שלה מהיתרה", amount: prevResult.safety, fundKind: "safety" });
  }
  return tasks.filter((t) => t.amount > 0);
}

export const DEFAULT_STATIONS = [
  { amount: 3000, name: "מחשב טוב למשחקי מחשב" },
  { amount: 5000, name: "גיטרה חשמלית ראשונה" },
  { amount: 10000, name: "טיול בר/בת מצווה מטורף" },
  { amount: 15000, name: "לעזור לטיול אחרי צבא" },
  { amount: 20000, name: "לטוס כולנו לסקי" },
  { amount: 30000, name: "תואר ראשון - מכוסה!" },
  { amount: 50000, name: "רכב חדש יהיה נחמד, לא?" },
  { amount: 75000, name: "עזרנו ממש בחתונה" },
  { amount: 100000, name: "דירה! (באום אל פחם…)" },
  { amount: 150000, name: "דירה! (אולי בב״ש?)" },
  { amount: 200000, name: "דירה! (בטוח בב״ש)" },
  { amount: 500000, name: "אפשר לעבוד על כולם שזכינו בלוטו?" }
];

export const DEFAULT_FUNDS = [
  { id: "invest", name: "קופת ההשקעה", kind: "invest", balance: 0 },
  { id: "vacation", name: "קופת חופשות", kind: "vacation", balance: 0 },
  { id: "safety", name: "קופת ביטחון", kind: "safety", balance: 0 }
];

export function stationProgress(stations, total) {
  const sorted = [...stations].sort((a, b) => a.amount - b.amount);
  const reached = sorted.filter((s) => s.amount <= total);
  const ahead = sorted.filter((s) => s.amount > total);
  const next = ahead[0] || null;
  const from = reached.length ? reached[reached.length - 1].amount : 0;
  const pct = next ? Math.max(0, Math.min(100, ((total - from) / (next.amount - from)) * 100)) : 100;
  return { sorted, reached, ahead, next, from, pct, left: next ? next.amount - total : 0 };
}

export function stationsCrossed(stations, before, after) {
  return stations.filter((s) => s.amount > before && s.amount <= after).sort((a, b) => a.amount - b.amount);
}

const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const percentile = (values, p) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
};
const ceilTo = (n, step) => Math.ceil(n / step) * step;

// closedMonths: newest first, each { id, lines: { catId: { spent, budget } } }
export function categoryHistory(closedMonths, category) {
  return closedMonths.slice(0, 6)
    .map((m) => ({ id: m.id, ...(m.lines?.[category.id] || {}) }))
    .filter((r) => typeof r.spent === "number" && !(category.freq === "two" && r.spent === 0));
}

export function insights(closedMonths, categories, { snoozed = {}, currentId = "" } = {}) {
  const recs = [];
  categories.filter((c) => c.type !== "fixed").forEach((cat) => {
    if (snoozed[cat.id] && snoozed[cat.id] > currentId) return;
    const history = categoryHistory(closedMonths, cat);
    if (history.length < 3) return;
    const budget = Number(cat.amount) || 0;
    const gap = Math.max(budget * 0.05, 30);
    const under = history.filter((r) => budget - r.spent >= gap).length;
    const over = history.filter((r) => r.spent - budget >= gap).length;
    const spentValues = history.map((r) => r.spent);
    if (under >= 3) {
      const target = Math.min(budget, ceilTo(Math.max(median(spentValues), percentile(spentValues, 0.75)), 50));
      const diff = budget - target;
      if (diff >= 30) recs.push({ kind: "reduce", category: cat, from: budget, to: target, diff, annual: diff * 12, count: under, months: history.length, history });
    } else if (over >= 3) {
      const target = ceilTo(median(spentValues), 50);
      const diff = target - budget;
      if (diff >= 30) recs.push({ kind: "raise", category: cat, from: budget, to: target, diff, annual: diff * 12, count: over, months: history.length, history });
    }
  });
  return recs.sort((a, b) => b.annual - a.annual).slice(0, 2);
}

export function categoryAverages(closedMonths, categories) {
  return categories.filter((c) => c.type !== "fixed").map((cat) => {
    const history = categoryHistory(closedMonths, cat);
    return { category: cat, months: history.length, median: Math.round(median(history.map((r) => r.spent))) };
  }).filter((r) => r.months > 0);
}

export const FIXED_GROUPS = ["בית", "קופות", "ביטוחים ובריאות", "תקשורת ובידור", "כלים וענן", "ספורט וחברות", "אחר"];

export function fixedGroupOf(item) {
  if (item.group) return item.group;
  const name = item.name || "";
  if (/קופ/.test(name) && !/חולים/.test(name)) return "קופות";
  if (/ארנונה|ועד/.test(name)) return "בית";
  if (/ביטוח|מכבי|כללית|מאוחדת/.test(name)) return "ביטוחים ובריאות";
  if (/כושר|ארגון/.test(name)) return "ספורט וחברות";
  if (/סלקום|טלוויזיה|נטפליקס|HBO|Spotify/i.test(name)) return "תקשורת ובידור";
  if (/GPT|Claude|Splice|Canva|Google|Apple|iCloud/i.test(name)) return "כלים וענן";
  return "אחר";
}

export const money = (n) => `${Math.round(n).toLocaleString("en-US")} ₪`;
