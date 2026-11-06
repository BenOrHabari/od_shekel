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

export function bankTasks(month, prevResult) {
  const kid = prevResult ? prevResult.kid : 0;
  const deposit = Number(month.deposit) || 0;
  const tasks = [{
    id: "invest", label: "לקופת ההשקעה", kid,
    detail: kid ? `${money(deposit)} הפקדה ו-${money(kid)} מתנה מהחודש הקודם` : "ההפקדה הקבועה לילד",
    amount: deposit + kid
  }];
  month.budgets.filter((b) => b.type === "fixed" && fixedGroupOf(b) === "קופות")
    .forEach((b) => tasks.push({ id: `fund-${b.id}`, label: `ל${b.name}`, detail: "העברה חודשית", amount: Number(b.amount) || 0 }));
  if (prevResult && prevResult.safety > 0) {
    tasks.push({ id: "safety", label: "לקופת הביטחון", detail: "החלק שלה מהיתרה", amount: prevResult.safety });
  }
  return tasks.filter((t) => t.amount > 0);
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
