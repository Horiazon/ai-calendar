"use client";
import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";

const HOURS = Array.from({ length: 18 }, (_, i) => i + 6);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VIEWS = ["day", "week", "month"];

function fmtDate(d: Date) { return d.toISOString().split("T")[0]; }
function today() { return fmtDate(new Date()); }
function parseLocalDate(s: string) { return new Date(s + "T12:00:00"); }

function getWeekDates(base: Date) {
  const d = new Date(base); d.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
}
function getMonthDates(base: Date) {
  const y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const cells: Date[] = []; let d = new Date(first); d.setDate(d.getDate() - d.getDay());
  while (d <= last || cells.length % 7 !== 0 || cells.length < 35) {
    cells.push(new Date(d)); d.setDate(d.getDate() + 1);
    if (cells.length > 42) break;
  }
  return cells;
}

const CAT_COLORS: Record<string, string> = {
  "deep work": "#6366f1", "study": "#6366f1", "learning": "#6366f1",
  "admin": "#f59e0b", "planning": "#f59e0b",
  "health": "#10b981", "exercise": "#10b981", "sport": "#10b981", "gym": "#10b981",
  "social": "#ec4899", "personal": "#ec4899",
  "rest": "#0ea5e9", "break": "#0ea5e9", "sleep": "#0ea5e9",
  "work": "#f97316", "meeting": "#f97316", "lecture": "#f97316",
  "other": "#64748b"
};
function catColor(cat = "other") {
  if (!cat) return "#64748b";
  const k = cat.toLowerCase();
  for (const [key, c] of Object.entries(CAT_COLORS)) if (k.includes(key)) return c;
  return "#64748b";
}

type Block = {
  id: number; title: string; date: string; start_h: number; start_m: number;
  dur: number; fixed: boolean; category: string; note: string;
  status: string; actual_dur?: number; user_id?: string;
};
type Habits = { completions: any[]; skips: any[]; actual_durs: number[] };

async function callAI(prompt: string, system?: string) {
  const res = await fetch("/api/schedule", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, system }),
  });
  const data = await res.json();
  return data.text as string;
}

export default function App() {
  const [isMobile, setIsMobile] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [view, setView] = useState("week");
  const [baseDate, setBaseDate] = useState(new Date());
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [habits, setHabits] = useState<Habits>({ completions: [], skips: [], actual_durs: [] });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatLog, setChatLog] = useState<{ role: string; text: string }[]>([]);
  const [selected, setSelected] = useState<Block | null>(null);
  const [eodPrompt, setEodPrompt] = useState<{ pending: Block[]; idx: number } | null>(null);
  const [actualDur, setActualDur] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setView("day");
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: b } = await supabase.from("blocks").select("*").eq("user_id", "default");
      if (b) setBlocks(b);
      const { data: h } = await supabase.from("habits").select("*").eq("user_id", "default").single();
      if (h) setHabits({ completions: h.completions || [], skips: h.skips || [], actual_durs: h.actual_durs || [] });
    })();
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatLog]);

  async function saveBlock(block: Block) {
    await supabase.from("blocks").upsert({ ...block, user_id: "default" });
  }
  async function saveHabits(h: Habits) {
    await supabase.from("habits").update({ completions: h.completions, skips: h.skips, actual_durs: h.actual_durs }).eq("user_id", "default");
  }

  const weekDates = getWeekDates(baseDate);
  const monthDates = getMonthDates(baseDate);
  const displayDates = view === "week" ? weekDates : view === "day" ? [baseDate] : monthDates;

  function blocksOn(dateStr: string) { return blocks.filter(b => b.date === dateStr); }

  function buildHabitSummary() {
    const { completions, skips, actual_durs } = habits;
    if (!completions.length && !skips.length) return "No habit data yet.";
    const lines = [];
    if (completions.length) {
      const hc: Record<number, number> = {};
      completions.forEach((c: any) => { hc[c.startH] = (hc[c.startH] || 0) + 1; });
      const best = Object.entries(hc).sort((a, b) => +b[1] - +a[1])[0];
      if (best) lines.push(`Most completions at ${best[0]}:00.`);
    }
    if (actual_durs.length) {
      const avg = actual_durs.reduce((a, b) => a + b, 0) / actual_durs.length;
      lines.push(`Avg actual duration: ${avg.toFixed(1)}h.`);
    }
    if (skips.length) {
      const sc: Record<string, number> = {};
      skips.forEach((s: any) => { sc[s.category] = (sc[s.category] || 0) + 1; });
      const most = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
      if (most) lines.push(`Most skipped: ${most[0]}.`);
    }
    return lines.join(" ") || "Insufficient data.";
  }

  async function handleAI() {
    const q = input.trim(); if (!q) return;
    setLoading(true); setInput(""); addChat("user", q);
    const habitSummary = buildHabitSummary();
    const blocksSummary = blocks.map(b =>
      `[${b.id}] "${b.title}" (${b.category || "other"}, ${b.fixed ? "FIXED" : "flexible"}) on ${b.date} at ${b.start_h}:${String(b.start_m).padStart(2, "0")} for ${b.dur}h`
    ).join("\n") || "none";

    const isQuery = /\?|which|how|when|what|free|busy|reschedule|optimis|suggest/i.test(q);

    if (isQuery) {
      const prompt = `You are a smart calendar assistant. Today is ${today()}.
Existing blocks:\n${blocksSummary}
Habit insights: ${habitSummary}
User question: "${q}"
Answer helpfully and concisely in plain text (no JSON).`;
      try { addChat("ai", await callAI(prompt)); }
      catch { addChat("ai", "Sorry, couldn't process that."); }
    } else {
      const prompt = `You are a smart calendar scheduling assistant. Today is ${today()}.

EXISTING BLOCKS (do NOT move FIXED ones; freely reschedule flexible ones if needed):
${blocksSummary}

HABIT INSIGHTS: ${habitSummary}

USER REQUEST: "${q}"

Instructions:
1. Parse into tasks. Break complex tasks into subtasks with time estimates.
2. Infer if each block is FIXED (appointments, lectures, meetings) or FLEXIBLE (study, gym, admin).
3. Infer a category from: deep work, study, health, admin, social, rest, work, meeting, lecture, other.
4. Auto-schedule: prefer mornings for deep work, avoid before 7:00 or after 22:00.
5. If existing FLEXIBLE blocks conflict, include them with updated times (same id).
6. Return ONLY a valid JSON array, no markdown. Each element:
{
  "id": number|null,
  "title": string,
  "date": "YYYY-MM-DD",
  "start_h": number,
  "start_m": 0|30,
  "dur": number,
  "fixed": boolean,
  "category": string,
  "note": string
}`;
      try {
        const raw = await callAI(prompt);
        const clean = raw.replace(/```json|```/g, "").trim();
        const parsed: any[] = JSON.parse(clean);
        const now = Date.now();
        const updated: Block[] = [];
        const newBlocks: Block[] = [];
        parsed.forEach((b, i) => {
          if (b.id == null) {
            newBlocks.push({ ...b, id: now + i, status: "pending", user_id: "default" });
          } else {
            updated.push(b);
          }
        });
        for (const nb of newBlocks) await saveBlock(nb);
        for (const ub of updated) await supabase.from("blocks").update(ub).eq("id", ub.id);
        setBlocks(prev => {
          let next = [...prev];
          updated.forEach(u => { const i = next.findIndex(x => x.id === u.id); if (i >= 0) next[i] = { ...next[i], ...u }; });
          return [...next, ...newBlocks];
        });
        const msg = [newBlocks.length && `Scheduled ${newBlocks.length} new block(s).`, updated.length && `Rescheduled ${updated.length} block(s).`].filter(Boolean).join(" ");
        addChat("ai", msg || "Done!");
        if (parsed.length) { setBaseDate(parseLocalDate(parsed[0].date)); if (isMobile) setShowAI(false); }
      } catch { addChat("ai", "Couldn't parse AI response — try rephrasing."); }
    }
    setLoading(false);
  }

  async function markComplete(block: Block) {
    const dur = parseFloat(actualDur) || block.dur;
    await supabase.from("blocks").update({ status: "done", actual_dur: dur }).eq("id", block.id);
    setBlocks(prev => prev.map(b => b.id === block.id ? { ...b, status: "done", actual_dur: dur } : b));
    const newH = { ...habits, completions: [...habits.completions, { startH: block.start_h, category: block.category, date: block.date }], actual_durs: [...habits.actual_durs, dur] };
    setHabits(newH); await saveHabits(newH);
    setActualDur(""); setSelected(null);
  }

  async function markSkipped(block: Block) {
    await supabase.from("blocks").update({ status: "skipped" }).eq("id", block.id);
    setBlocks(prev => prev.map(b => b.id === block.id ? { ...b, status: "skipped" } : b));
    const newH = { ...habits, skips: [...habits.skips, { category: block.category, date: block.date }] };
    setHabits(newH); await saveHabits(newH);
    setSelected(null);
  }

  async function deleteBlock(id: number) {
    await supabase.from("blocks").delete().eq("id", id);
    setBlocks(prev => prev.filter(b => b.id !== id)); setSelected(null);
  }

  async function toggleFixed(id: number) {
    const block = blocks.find(b => b.id === id); if (!block) return;
    await supabase.from("blocks").update({ fixed: !block.fixed }).eq("id", id);
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, fixed: !b.fixed } : b));
  }

  function startEodReview() {
    const pending = blocks.filter(b => b.date === today() && b.status === "pending");
    if (!pending.length) { addChat("ai", "No pending blocks for today!"); return; }
    setEodPrompt({ pending, idx: 0 });
  }

  async function eodNext(action: string, dur: string) {
    if (!eodPrompt) return;
    const { pending, idx } = eodPrompt;
    const block = pending[idx];
    if (action === "done") await markComplete({ ...block });
    else await markSkipped(block);
    if (idx + 1 >= pending.length) setEodPrompt(null);
    else setEodPrompt({ ...eodPrompt, idx: idx + 1 });
  }

  function addChat(role: string, text: string) { setChatLog(l => [...l, { role, text }]); }

  function navigate(dir: number) {
    const d = new Date(baseDate);
    if (view === "week") d.setDate(d.getDate() + dir * 7);
    else if (view === "day") d.setDate(d.getDate() + dir);
    else d.setMonth(d.getMonth() + dir);
    setBaseDate(d);
  }

  const headerLabel = view === "week"
    ? `${weekDates[0].toLocaleDateString("en-GB", { month: "short", day: "numeric" })} – ${weekDates[6].toLocaleDateString("en-GB", { month: "short", day: "numeric", year: "numeric" })}`
    : view === "day"
      ? baseDate.toLocaleDateString("en-GB", { weekday: isMobile ? "short" : "long", month: "short", day: "numeric", year: "numeric" })
      : baseDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  function blockTop(b: Block) { return (b.start_h + b.start_m / 60 - 6) * 56; }
  function blockHeight(b: Block) { return b.dur * 56 - 2; }
  function blockOpacity(b: Block) { return b.status === "skipped" ? 0.35 : b.status === "done" ? 0.65 : 1; }

  const AIPanel = (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <div style={{ padding: 12, borderBottom: "1px solid #1e293b" }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: "#818cf8", marginBottom: 6 }}>✨ AI Assistant</div>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAI(); } }}
          placeholder={"Schedule a task…\nor ask: \"Which day am I most free?\""} disabled={loading}
          style={{ width: "100%", height: 72, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12, padding: 8, resize: "none", boxSizing: "border-box", outline: "none" }} />
        <button onClick={handleAI} disabled={loading || !input.trim()}
          style={{ width: "100%", marginTop: 6, padding: "7px 0", background: loading || !input.trim() ? "#1e293b" : "#6366f1", color: loading || !input.trim() ? "#475569" : "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: loading ? "not-allowed" : "pointer" }}>
          {loading ? "Thinking…" : "Send ↵"}
        </button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {chatLog.length === 0 && <div style={{ color: "#334155", fontSize: 11, textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>Schedule tasks or ask questions.<br />e.g. "Study MA203 3h tomorrow"</div>}
        {chatLog.map((m, i) => (
          <div key={i} style={{ background: m.role === "user" ? "#1e293b" : "#1e1b4b", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: m.role === "user" ? "#94a3b8" : "#a5b4fc", alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "92%", lineHeight: 1.5 }}>
            {m.text}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div style={{ padding: "8px 12px", borderTop: "1px solid #1e293b", display: "flex", flexWrap: "wrap", gap: 4 }}>
        {Object.entries({ "Study": "#6366f1", "Health": "#10b981", "Admin": "#f59e0b", "Social": "#ec4899", "Rest": "#0ea5e9", "Work/Meeting": "#f97316", "Other": "#64748b" }).map(([k, c]) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "#64748b" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: c, display: "inline-block" }} />{k}
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: "Inter,sans-serif", display: "flex", flexDirection: "column", height: "100vh", background: "#0b0f1a", color: "#e2e8f0", overflow: "hidden" }}>
      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, padding: isMobile ? "8px 10px" : "10px 16px", borderBottom: "1px solid #1e293b", flexShrink: 0, background: "#0f172a" }}>
        <span style={{ fontWeight: 800, fontSize: isMobile ? 14 : 17, color: "#818cf8", letterSpacing: "-0.5px", marginRight: 2 }}>⬡ {!isMobile && "AI Calendar"}</span>
        <button onClick={() => navigate(-1)} style={S.nav}>‹</button>
        <button onClick={() => setBaseDate(new Date())} style={{ ...S.nav, fontSize: 11, padding: "3px 8px" }}>Today</button>
        <button onClick={() => navigate(1)} style={S.nav}>›</button>
        <span style={{ flex: 1, textAlign: "center", fontWeight: 600, fontSize: isMobile ? 11 : 13, color: "#94a3b8" }}>{headerLabel}</span>
        {!isMobile && VIEWS.map(v => (
          <button key={v} onClick={() => setView(v)} style={{ ...S.tab, background: view === v ? "#6366f1" : "#1e293b", textTransform: "capitalize" }}>{v}</button>
        ))}
        {isMobile && (
          <button onClick={() => setView(v => v === "day" ? "week" : "day")} style={{ ...S.tab, background: "#1e293b", fontSize: 11 }}>{view === "day" ? "Week" : "Day"}</button>
        )}
        <button onClick={startEodReview} style={{ ...S.tab, background: "#1e293b", color: "#fbbf24", border: "1px solid #78350f" }}>{isMobile ? "☀" : "☀ Review"}</button>
        {isMobile && (
          <button onClick={() => setShowAI(true)} style={{ ...S.tab, background: "#6366f1", color: "#fff" }}>✨ AI</button>
        )}
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* calendar */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {view !== "month" && (
            <div style={{ display: "flex", borderBottom: "1px solid #1e293b", flexShrink: 0, background: "#0f172a" }}>
              <div style={{ width: 48 }} />
              {displayDates.map((d, i) => {
                const isToday = fmtDate(d) === today();
                return (
                  <div key={i} onClick={() => { setBaseDate(d); setView("day"); }}
                    style={{ flex: 1, textAlign: "center", padding: "6px 0", cursor: "pointer", color: isToday ? "#818cf8" : "#64748b", fontWeight: isToday ? 700 : 500, fontSize: 12 }}>
                    <div>{DAYS[d.getDay()]}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: isToday ? "#818cf8" : "#e2e8f0", background: isToday ? "#1e1b4b" : "transparent", borderRadius: "50%", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", margin: "2px auto 0" }}>
                      {d.getDate()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ flex: 1, overflow: "auto" }}>
            {view === "month" ? (
              <MonthView dates={monthDates} blocks={blocks} baseDate={baseDate} onDayClick={d => { setBaseDate(d); setView("day"); }} onBlockClick={setSelected} />
            ) : (
              <div style={{ display: "flex", position: "relative" }}>
                <div style={{ width: 48, flexShrink: 0 }}>
                  {HOURS.map(h => (
                    <div key={h} style={{ height: 56, borderBottom: "1px solid #1e293b", display: "flex", alignItems: "flex-start", paddingTop: 2, justifyContent: "flex-end", paddingRight: 6, fontSize: 10, color: "#334155" }}>
                      {h === 12 ? "12pm" : h > 12 ? `${h - 12}pm` : `${h}am`}
                    </div>
                  ))}
                </div>
                {displayDates.map((d, di) => {
                  const ds = fmtDate(d), db = blocksOn(ds);
                  return (
                    <div key={di} style={{ flex: 1, position: "relative", borderLeft: "1px solid #1e293b" }}>
                      {HOURS.map(h => <div key={h} style={{ height: 56, borderBottom: "1px solid #0f172a" }} />)}
                      {db.map(b => (
                        <div key={b.id} onClick={() => setSelected(b)}
                          style={{ position: "absolute", left: 2, right: 2, borderRadius: 6, padding: "3px 6px", cursor: "pointer", overflow: "hidden", top: blockTop(b), height: blockHeight(b), background: catColor(b.category), opacity: blockOpacity(b), border: b.fixed ? "2px solid rgba(255,255,255,0.35)" : "none", boxShadow: "0 2px 6px rgba(0,0,0,0.4)" }}>
                          <div style={{ fontWeight: 700, fontSize: 11, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {b.fixed ? "📌 " : ""}{b.title}{b.status === "done" && " ✓"}{b.status === "skipped" && " ✗"}
                          </div>
                          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.75)" }}>{b.start_h}:{String(b.start_m).padStart(2, "0")} · {b.dur}h</div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* desktop AI panel */}
        {!isMobile && (
          <div style={{ width: 288, borderLeft: "1px solid #1e293b", display: "flex", flexDirection: "column", flexShrink: 0, background: "#0f172a" }}>
            {AIPanel}
          </div>
        )}
      </div>

      {/* mobile AI bottom sheet */}
      {isMobile && showAI && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 150 }} onClick={() => setShowAI(false)}>
          <div onClick={e => e.stopPropagation()} style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "#0f172a", borderRadius: "16px 16px 0 0", padding: "12px 16px 24px", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
            <div style={{ width: 40, height: 4, background: "#334155", borderRadius: 2, margin: "0 auto 12px" }} />
            {AIPanel}
          </div>
        </div>
      )}

      {selected && <BlockModal block={selected} onClose={() => { setSelected(null); setActualDur(""); }} onDelete={() => deleteBlock(selected.id)} onToggleFixed={() => toggleFixed(selected.id)} onComplete={() => markComplete(selected)} onSkip={() => markSkipped(selected)} actualDur={actualDur} setActualDur={setActualDur} />}
      {eodPrompt && <EodModal state={eodPrompt} onAction={eodNext} onClose={() => setEodPrompt(null)} />}
    </div>
  );
}

function MonthView({ dates, blocks, baseDate, onDayClick, onBlockClick }: { dates: Date[]; blocks: Block[]; baseDate: Date; onDayClick: (d: Date) => void; onBlockClick: (b: Block) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", height: "100%" }}>
      {DAYS.map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "#475569", padding: "6px 0", borderBottom: "1px solid #1e293b", borderRight: "1px solid #1e293b" }}>{d}</div>)}
      {dates.map((d, i) => {
        const ds = fmtDate(d), db = blocks.filter(b => b.date === ds);
        const isToday = ds === fmtDate(new Date()), inMonth = d.getMonth() === baseDate.getMonth();
        return (
          <div key={i} onClick={() => onDayClick(d)} style={{ minHeight: 90, borderRight: "1px solid #1e293b", borderBottom: "1px solid #1e293b", padding: 4, cursor: "pointer", background: isToday ? "#1e1b4b" : "transparent", opacity: inMonth ? 1 : 0.35 }}>
            <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? "#818cf8" : "#94a3b8", marginBottom: 2 }}>{d.getDate()}</div>
            {db.slice(0, 3).map(b => <div key={b.id} onClick={e => { e.stopPropagation(); onBlockClick(b); }} style={{ background: catColor(b.category), borderRadius: 3, padding: "1px 4px", marginBottom: 2, fontSize: 10, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: b.status === "skipped" ? 0.35 : b.status === "done" ? 0.65 : 1 }}>{b.title}</div>)}
            {db.length > 3 && <div style={{ fontSize: 10, color: "#475569" }}>+{db.length - 3} more</div>}
          </div>
        );
      })}
    </div>
  );
}

function BlockModal({ block, onClose, onDelete, onToggleFixed, onComplete, onSkip, actualDur, setActualDur }: { block: Block; onClose: () => void; onDelete: () => void; onToggleFixed: () => void; onComplete: () => void; onSkip: () => void; actualDur: string; setActualDur: (s: string) => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#1e293b", borderRadius: 12, padding: 20, width: 300, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", margin: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: catColor(block.category), flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: 15, color: "#e2e8f0", flex: 1 }}>{block.title}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>📅 {block.date} &nbsp;⏰ {block.start_h}:{String(block.start_m).padStart(2, "0")} &nbsp;⌛ {block.dur}h</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>🏷 {block.category || "other"} &nbsp;<span style={{ color: block.fixed ? "#fbbf24" : "#475569" }}>{block.fixed ? "📌 Fixed" : "⟳ Flexible"}</span></div>
        {block.note && <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8, fontStyle: "italic" }}>{block.note}</div>}
        {block.status && block.status !== "pending" && <div style={{ fontSize: 12, color: block.status === "done" ? "#10b981" : "#ef4444", marginBottom: 8, fontWeight: 600 }}>{block.status === "done" ? `✓ Completed (${block.actual_dur || block.dur}h)` : "✗ Skipped"}</div>}
        {(!block.status || block.status === "pending") && <>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Actual duration (hrs):</div>
          <input type="number" value={actualDur} onChange={e => setActualDur(e.target.value)} placeholder={String(block.dur)} min="0.5" max="12" step="0.5" style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", padding: "5px 8px", fontSize: 12, boxSizing: "border-box", marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button onClick={onComplete} style={{ ...S.btn, flex: 1, background: "#052e16", color: "#4ade80", border: "1px solid #166534" }}>✓ Done</button>
            <button onClick={onSkip} style={{ ...S.btn, flex: 1, background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d" }}>✗ Skip</button>
          </div>
        </>}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onToggleFixed} style={{ ...S.btn, flex: 1, background: "#1e1b4b", color: "#818cf8", border: "1px solid #3730a3", fontSize: 11 }}>{block.fixed ? "Unfix" : "📌 Fix"}</button>
          <button onClick={onDelete} style={{ ...S.btn, flex: 1, background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d", fontSize: 11 }}>🗑 Delete</button>
        </div>
      </div>
    </div>
  );
}

function EodModal({ state, onAction, onClose }: { state: { pending: Block[]; idx: number }; onAction: (a: string, d: string) => void; onClose: () => void }) {
  const [dur, setDur] = useState("");
  const block = state.pending[state.idx];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: "#1e293b", borderRadius: 14, padding: 24, width: 320, boxShadow: "0 8px 40px rgba(0,0,0,0.6)", margin: "0 16px" }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#fbbf24", marginBottom: 4 }}>☀ End-of-day Review</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>{state.idx + 1} / {state.pending.length}</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#e2e8f0", marginBottom: 4 }}>{block.title}</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Scheduled: {block.start_h}:{String(block.start_m).padStart(2, "0")} · {block.dur}h</div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Actual duration (hrs):</div>
        <input type="number" value={dur} onChange={e => setDur(e.target.value)} placeholder={String(block.dur)} min="0.5" max="12" step="0.5" style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", padding: "5px 8px", fontSize: 12, boxSizing: "border-box", marginBottom: 12 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { onAction("done", dur); setDur(""); }} style={{ ...S.btn, flex: 1, background: "#052e16", color: "#4ade80", border: "1px solid #166534", fontSize: 13 }}>✓ Completed</button>
          <button onClick={() => { onAction("skip", ""); setDur(""); }} style={{ ...S.btn, flex: 1, background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d", fontSize: 13 }}>✗ Skipped</button>
        </div>
        <button onClick={onClose} style={{ ...S.btn, width: "100%", marginTop: 8, background: "#1e293b", color: "#475569", border: "1px solid #334155", fontSize: 11 }}>Cancel review</button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  nav: { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "3px 12px", cursor: "pointer", fontSize: 16 },
  tab: { color: "#e2e8f0", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 },
  btn: { padding: "7px 0", borderRadius: 7, cursor: "pointer", fontWeight: 600, fontSize: 12, textAlign: "center" as const },
};