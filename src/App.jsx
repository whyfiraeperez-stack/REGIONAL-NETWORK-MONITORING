import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
const TABS = ["DASHBOARD", "OUTAGE ADVISORY", "DATABASE", "GNOC UPDATE", "GENERATE REPORT"];
const LOGO = "https://content.convergeict.com/assets/25c65629-d1ee-43a3-82bd-5bed31ecbf06.svg";
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const val = (row, names) => { for (const n of names) { const k = Object.keys(row || {}).find((x) => norm(x) === norm(n)); if (k && row[k] !== "" && row[k] != null) return String(row[k]).trim(); } return ""; };
const runningStatus = (s) => /\b(running|open|pending|ongoing|in progress|active)\b/i.test(String(s || ""));
const completeStatus = (s) => /\b(completed|restored|closed|resolved)\b/i.test(String(s || ""));
const ageing = (start, end) => { const a = new Date(start); const b = end ? new Date(end) : new Date(); if (!start || isNaN(a.getTime()) || isNaN(b.getTime())) return "—"; const m = Math.max(0, Math.floor((b-a)/60000)); const d=Math.floor(m/1440), h=Math.floor((m%1440)/60), mm=m%60; return (d ? d+"d " : "")+h+"h "+mm+"m"; };
const sheetRows = (s) => s?.rows || [];
const sheetHeaders = (s) => s?.headers || [];
const regionalOverviewCounts = (sheet) => {
 const counts = { BB: null, OLT: null, LCP: null, NAP: null };
 const grid = Array.isArray(sheet?.raw) ? sheet.raw : [];
 if (!grid.length) return counts;
 const clean = (value) => String(value ?? "").trim();
 const number = (value) => {
  const text = clean(value).replace(/,/g, "");
  return text && /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
 };

 // The DAILY REPORT uses four side-by-side sections. Each section has a
 // province/type column, then UP, DOWN, TOTAL and a percentage column.
 // Read the DOWN value from that section's TOTAL row rather than looking
 // for a literal "BB DOWN" cell (the sheet does not contain such a label).
 const sectionRowIndex = grid.findIndex((row) => {
  const labels = (row || []).map((cell) => clean(cell).toUpperCase());
  return ["BB", "OLT", "LCP", "NAP"].filter((name) => labels.includes(name)).length >= 2;
 });
 if (sectionRowIndex < 0) return counts;

 const sectionRow = grid[sectionRowIndex] || [];
 const headerRowIndex = grid.findIndex((row, index) =>
  index > sectionRowIndex &&
  (row || []).some((cell) => clean(cell).toUpperCase() === "DOWN")
 );
 if (headerRowIndex < 0) return counts;
 const headerRow = grid[headerRowIndex] || [];
 const sections = ["BB", "OLT", "LCP", "NAP"]
  .map((name) => ({ name, start: sectionRow.findIndex((cell) => clean(cell).toUpperCase() === name) }))
  .filter((section) => section.start >= 0)
  .sort((a, b) => a.start - b.start);

 for (let index = 0; index < sections.length; index++) {
  const section = sections[index];
  const nextStart = sections[index + 1]?.start ?? headerRow.length;
  let downColumn = -1;
  for (let column = section.start; column < nextStart; column++) {
   if (clean(headerRow[column]).toUpperCase() === "DOWN") {
    downColumn = column;
    break;
   }
  }
  if (downColumn < 0) continue;

  const totalRow = grid.slice(headerRowIndex + 1).find((row) =>
   clean((row || [])[section.start]).toUpperCase() === "TOTAL"
  );
  if (!totalRow) continue;
  const value = number(totalRow[downColumn]);
  if (value !== null) counts[section.name] = value;
 }
 return counts;
};
function Table({ rows = [], headers = [], limit = 250 }) {
 const safeRows = Array.isArray(rows) ? rows : [];
 const safeHeaders = Array.isArray(headers) ? headers : [];
 if (!safeRows.length) return <div className="empty">No records returned for this tab.</div>;
 const cols = safeHeaders.length ? safeHeaders : Object.keys(safeRows[0] || {});
 return <div className="table-wrap"><table><thead><tr>{cols.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{safeRows.slice(0,limit).map((r,i)=><tr key={i}>{cols.map((h)=><td key={h}>{String(r?.[h] ?? "—")}</td>)}</tr>)}</tbody></table>{safeRows.length>limit && <p className="muted small">Showing first {limit} of {safeRows.length} rows.</p>}</div>;
}
function csvDownload(rows, filename) {
 if (!rows.length) return;
 const cols = Object.keys(rows[0]);
 const csv = [cols, ...rows.map((row) => cols.map((header) => row[header] ?? ""))]
  .map((row) => row.map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(","))
  .join("\r\n");
 const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
 const anchor = document.createElement("a");
 anchor.href = url;
 anchor.download = filename;
 document.body.appendChild(anchor);
 anchor.click();
 anchor.remove();
 window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
 const [tab,setTab]=useState("DASHBOARD"), [data,setData]=useState({}), [status,setStatus]=useState("connecting"), [lastSync,setLastSync]=useState(null), [error,setError]=useState(""), [auto,setAuto]=useState(true), [query,setQuery]=useState(""), [statusFilter,setStatusFilter]=useState("ALL"), [typeFilter,setTypeFilter]=useState("ALL"), [clock,setClock]=useState(new Date());
 const syncInFlight = useRef(false);
 const sync=useCallback(async()=>{if(syncInFlight.current)return;syncInFlight.current=true;setStatus("syncing");try{const r=await fetch("/api/sheets",{method:"GET",cache:"no-store",headers:{accept:"application/json"}});const contentType=r.headers.get("content-type")||"";const body=await r.text();if(!contentType.toLowerCase().includes("application/json")){const preview=body.slice(0,140).replace(/\\s+/g," ").trim();throw new Error("The /api/sheets endpoint returned "+(contentType||"an unknown content type")+" (HTTP "+r.status+") instead of JSON. Cloudflare may be serving the dashboard HTML instead of the Worker API. Response: "+preview);}let p;try{p=JSON.parse(body);}catch{throw new Error("The spreadsheet API returned invalid JSON (HTTP "+r.status+").");}if(!r.ok)throw new Error(p.error||"Google Sheets request failed (HTTP "+r.status+").");if(!p.sheets||typeof p.sheets!=="object")throw new Error("The spreadsheet API response is missing its sheets data.");setData(p.sheets);setLastSync(new Date(p.syncedAt||Date.now()));setStatus("online");setError("");}catch(e){setStatus("error");setError(e.message||"Unable to synchronize.");}finally{syncInFlight.current=false;}},[]);
 useEffect(()=>{sync();},[sync]); useEffect(()=>{if(!auto)return;const id=setInterval(sync,30000);return()=>clearInterval(id);},[auto,sync]); useEffect(()=>{const id=setInterval(()=>setClock(new Date()),30000);return()=>clearInterval(id);},[]);
 const db=sheetRows(data.DATABASE), gnoc=sheetRows(data.GNOC), adv=sheetRows(data["OUTAGE ADVISORY"]), daily=sheetRows(data["DAILY REPORT"]);
 const tickets=useMemo(()=>db.map((r,i)=>{const statusText=val(r,["STATUS"]);const down=val(r,["DOWNTIME","DOWN TIME","START DATE"]);const restored=val(r,["DATE RESTORED","DATE RESTORE","RESTORED DATE","UPTIME"]);return {...r,__ticket:val(r,["TICKET","TICKET ID","INTERNAL ID"])||("ROW-"+(i+1)),__status:runningStatus(statusText)?"RUNNING":completeStatus(statusText)?"COMPLETED":statusText.toUpperCase(),__type:val(r,["TYPE","OUTAGE TYPE","TYPE/PROVINCE","IMPACT"]).toUpperCase(),__ageing:ageing(down,restored)};}),[db]);
 const running=tickets.filter(r=>r.__status==="RUNNING"), completed=tickets.filter(r=>r.__status==="COMPLETED");
 const kpis=useMemo(()=>{
  const extracted=regionalOverviewCounts(data["DAILY REPORT"]);
  const fallback={BB:0,OLT:0,LCP:0,NAP:0};
  for(const r of running){
   const s=(r.__type+" "+Object.values(r).join(" ")).toUpperCase();
   if(/BACKBONE|\\bBB\\b/.test(s))fallback.BB++;
   else if(/\\bOLT\\b/.test(s))fallback.OLT++;
   else if(/\\bLCP\\b/.test(s))fallback.LCP++;
   else if(/\\bNAP\\b/.test(s))fallback.NAP++;
  }
  return {BB:extracted.BB??fallback.BB,OLT:extracted.OLT??fallback.OLT,LCP:extracted.LCP??fallback.LCP,NAP:extracted.NAP??fallback.NAP};
 },[data,running]);
 const filtered=tickets.filter(r=>{if(statusFilter!=="ALL"&&r.__status!==statusFilter)return false;if(typeFilter!=="ALL"&&!r.__type.includes(typeFilter))return false;return !query||Object.values(r).join(" ").toLowerCase().includes(query.toLowerCase());});
 const phTime=clock.toLocaleString("en-PH",{timeZone:"Asia/Manila",dateStyle:"medium",timeStyle:"medium"});
 const report=tickets.map(r=>({...r,"Ticket Ageing":r.__ageing}));
 return <div className="app">
 <header className="topbar"><div className="brand"><img src={LOGO} alt="Converge ICT Solutions" onError={e=>{e.currentTarget.style.display="none";}}/><div><h1>BICOL NETWORK MONITORING</h1><p>NETWORK OPERATIONS CENTER · REGIONAL OUTAGE OPERATIONS</p></div></div><div className="top-actions"><div className="clock">{phTime} <span>PH TIME</span></div><span className={"connection "+status}>{status==="online"?"● CONNECTED":status==="syncing"?"↻ SYNCING":status==="error"?"● SYNC ERROR":"● CONNECTING"}</span><button className="button secondary" onClick={()=>setAuto(!auto)}>AUTO-SYNC {auto?"ON":"OFF"}</button><button className="button primary" onClick={sync}>↻ SYNC NOW</button></div></header>
 <nav className="nav">{TABS.map(t=><button key={t} className={tab===t?"active":""} onClick={()=>setTab(t)}>{t}</button>)}</nav><main>
 {error&&<div className="alert"><strong>Spreadsheet sync unavailable.</strong> {error}<span>Last successful sync: {lastSync?lastSync.toLocaleString():"None"}</span></div>}
 {tab==="DASHBOARD"&&<><div className="section-heading"><div><p className="eyebrow">LIVE NETWORK OPERATIONS</p><h2>Regional outage overview</h2></div><div className="sync-label">Last successful sync: {lastSync?lastSync.toLocaleTimeString():"Waiting for data"}</div></div>
 <div className="kpis"><article className="kpi running"><span>RUNNING TICKETS</span><strong>{running.length}</strong><small>DATABASE · ACTIVE RECORDS</small></article><article className="kpi red"><span>BB DOWN</span><strong>{kpis.BB}</strong><small>DAILY REPORT</small></article><article className="kpi amber"><span>OLT DOWN</span><strong>{kpis.OLT}</strong><small>DAILY REPORT</small></article><article className="kpi blue"><span>LCP DOWN</span><strong>{kpis.LCP}</strong><small>DAILY REPORT</small></article><article className="kpi green"><span>NAP DOWN</span><strong>{kpis.NAP}</strong><small>DAILY REPORT</small></article></div>
 <div className="grid-two"><section className="panel"><div className="panel-head"><h3>OUTAGE ADVISORY</h3><span>{adv.length} source rows</span></div><Table rows={adv} headers={sheetHeaders(data["OUTAGE ADVISORY"])} limit={8}/></section><section className="panel"><div className="panel-head"><h3>GNOC UPDATE</h3><span>{gnoc.length} source rows</span></div><Table rows={gnoc} headers={sheetHeaders(data.GNOC)} limit={8}/></section></div>
 <section className="panel"><div className="panel-head"><h3>RUNNING TICKETS</h3><button className="text-button" onClick={()=>setTab("DATABASE")}>VIEW DATABASE →</button></div><Table rows={running.map(r=>({"Ticket ID":r.__ticket,"Status":r.__status,"Type":r.__type,"Ageing":r.__ageing,...r}))} limit={12}/></section></>}
 {tab==="OUTAGE ADVISORY"&&<section className="panel"><div className="panel-head"><h2>OUTAGE ADVISORY</h2><span>Source: OUTAGE ADVISORY tab</span></div><Table rows={adv} headers={sheetHeaders(data["OUTAGE ADVISORY"])}/></section>}
 {tab==="DATABASE"&&<section className="panel"><div className="panel-head"><div><h2>NETWORK TICKET DATABASE</h2><p className="muted">{filtered.length} matching · {tickets.length} total records</p></div><button className="button secondary" onClick={()=>csvDownload(filtered,"bicol-network-database.csv")}>EXPORT CSV</button></div><div className="filters"><input placeholder="Search ticket ID, last digits, node, municipality..." value={query} onChange={e=>setQuery(e.target.value)}/><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="ALL">All statuses</option><option value="RUNNING">Running</option><option value="COMPLETED">Completed</option></select><select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option value="ALL">All types</option>{["BB","OLT","LCP","NAP"].map(v=><option key={v}>{v}</option>)}</select></div><Table rows={filtered.map(({__ticket,__status,__type,__ageing,...r})=>({...r,"Ticket ID":__ticket,"Normalized Status":__status,"Outage Type":__type,"Ageing":__ageing}))}/></section>}
 {tab==="GNOC UPDATE"&&<section className="panel"><div className="panel-head"><h2>GNOC UPDATE</h2><span>{gnoc.length} records · live spreadsheet view</span></div><Table rows={gnoc} headers={sheetHeaders(data.GNOC)}/></section>}
 {tab==="GENERATE REPORT"&&<><div className="section-heading"><div><p className="eyebrow">OPERATIONS INTELLIGENCE</p><h2>Outage performance report</h2></div><button className="button primary" onClick={()=>csvDownload(report,"bicol-network-outage-report.csv")}>DOWNLOAD REPORT CSV</button></div><div className="kpis"><article className="kpi running"><span>TOTAL TICKETS</span><strong>{tickets.length}</strong></article><article className="kpi red"><span>RUNNING</span><strong>{running.length}</strong></article><article className="kpi green"><span>COMPLETED</span><strong>{completed.length}</strong></article><article className="kpi blue"><span>COMPLETION RATE</span><strong>{tickets.length?Math.round(completed.length/tickets.length*100):0}%</strong></article></div><section className="panel"><div className="panel-head"><h3>COMPLETED TICKETS · RESTORATION AGEING</h3></div><Table rows={completed.map(r=>({"Ticket ID":r.__ticket,"Status":r.__status,"Type":r.__type,"Downtime":val(r,["DOWNTIME","DOWN TIME"]),"Date Restored":val(r,["DATE RESTORED","DATE RESTORE","RESTORED DATE"]),"Ageing":r.__ageing}))}/></section><section className="panel"><div className="panel-head"><h3>RUNNING TICKETS · CURRENT AGEING</h3></div><Table rows={running.map(r=>({"Ticket ID":r.__ticket,"Status":r.__status,"Type":r.__type,"Downtime":val(r,["DOWNTIME","DOWN TIME"]),"Ageing":r.__ageing}))}/></section></>}
 <footer>Operational dashboard · Google Sheets is the source of truth · Auto-sync interval: 30 seconds</footer></main></div>;
}
