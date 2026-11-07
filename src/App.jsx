import React, { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';

// Google Sheet ID from your URL
const SPREADSHEET_ID = '1DgYA7-nM4DoVg70YOEGlu4Au7nb7xNpdSzyW8BZFsOg';

// Helper to fetch any tab via GViz CSV export
const getSheetCsvUrl = (tabName) =>
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tabName
  )}&_=${Date.now()}`;

// Safely calculate ageing duration between two dates
const calculateAgeing = (startStr, endStr) => {
  if (!startStr) return { text: '—', totalHours: 0, days: 0, hours: 0, mins: 0 };
  const start = new Date(startStr);
  const end = endStr ? new Date(endStr) : new Date();
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { text: 'Invalid Date', totalHours: 0, days: 0, hours: 0, mins: 0 };
  }
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  const totalMins = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  const totalHours = (diffMs / (1000 * 60 * 60)).toFixed(1);

  let text = '';
  if (days > 0) text += `${days}d `;
  text += `${hours}h ${mins}m`;
  return { text, totalHours: parseFloat(totalHours), days, hours, mins };
};

export default function App() {
  const [activeTab, setActiveTab] = useState('DASHBOARD'); // DASHBOARD, DATABASE, GNOC, REPORT
  const [databaseRows, setDatabaseRows] = useState([]);
  const [gnocRows, setGnocRows] = useState([]);
  const [databaseHeaders, setDatabaseHeaders] = useState([]);
  const [gnocHeaders, setGnocHeaders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Search & Filter States
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProvince, setSelectedProvince] = useState('ALL');
  const [selectedType, setSelectedType] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState('ALL');

  // Outage Advisory Editable Pickers
  const [pendingTicketId, setPendingTicketId] = useState('');
  const [completedTicketId, setCompletedTicketId] = useState('');
  const [copiedState, setCopiedState] = useState(null);

  // Fetch data from Google Sheets
  const fetchAllSheets = async () => {
    try {
      // 1. Fetch DATABASE tab
      Papa.parse(getSheetCsvUrl('DATABASE'), {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.data && results.data.length > 0) {
            setDatabaseHeaders(results.meta.fields || []);
            setDatabaseRows(results.data);

            // Auto-select initial pending & completed tickets if empty
            const running = results.data.filter((r) =>
              String(r.STATUS || r.Status || '').trim().toLowerCase().includes('running')
            );
            const completed = results.data.filter((r) =>
              String(r.STATUS || r.Status || '').trim().toLowerCase().includes('complete')
            );

            if (running.length > 0 && !pendingTicketId) {
              setPendingTicketId(running[running.length - 1].TICKET || running[running.length - 1].Ticket || '');
            }
            if (completed.length > 0 && !completedTicketId) {
              setCompletedTicketId(completed[completed.length - 1].TICKET || completed[completed.length - 1].Ticket || '');
            }
          }
        },
      });

      // 2. Fetch GNOC tab
      Papa.parse(getSheetCsvUrl('GNOC'), {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.data && results.data.length > 0) {
            setGnocHeaders(results.meta.fields || []);
            setGnocRows(results.data);
          }
        },
      });

      setLastSynced(new Date().toLocaleTimeString());
      setLoading(false);
    } catch (err) {
      console.error('Fetch error:', err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllSheets();
    if (!autoRefresh) return;
    const interval = setInterval(fetchAllSheets, 30000); // Live poll every 30 seconds
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Normalized ticket records with lookup keys
  const normalizedTickets = useMemo(() => {
    return databaseRows.map((row, idx) => {
      const getVal = (candidates, fallback = '') => {
        for (const c of candidates) {
          const found = Object.keys(row).find(
            (k) => k.trim().toLowerCase() === c.trim().toLowerCase()
          );
          if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== '') {
            return String(row[found]).trim();
          }
        }
        return fallback;
      };

      const ticket = getVal(['TICKET', 'Ticket', 'Ticket ID', 'INTERNAL ID'], `TT-${idx}`);
      const status = getVal(['STATUS', 'Status'], 'Pending');
      const type = getVal(['TYPE', 'Type', 'OUTAGE TYPE', 'SEVERITY'], 'NAP').toUpperCase();
      const province = getVal(['TYPE/PROVINCE', 'PROVINCE', 'Province', 'AREA'], 'CAMARINES SUR').toUpperCase();
      const municipality = getVal(['MUNICIPALITY', 'Municipality', 'CITY'], 'N/A');
      const barangay = getVal(['BARANGAY', 'Barangay'], 'N/A');
      const subject = getVal(['SUBJECT', 'Subject', 'DESCRIPTION'], `${ticket} - ${type} DOWN`);
      const nodes = getVal(['AFFECTED NODES/LINKS', 'AFFECTED NODES', 'NODES', 'NAP CODE / OLT'], 'N/A');
      const downtime = getVal(['DOWNTIME', 'Downtime', 'DOWN TIME', 'START DATE'], '');
      const etr = getVal(['ETR', 'Etr', 'ESTIMATED TIME OF RESTORATION'], 'TBD');
      const dateRestored = getVal(['DATE RESTORED', 'Date Restored', 'UPTIME', 'RESTORED DATE'], '');
      const rfo = getVal(['RFO', 'Rfo', 'REASON FOR OUTAGE', 'CAUSE'], 'TBD');
      const actionTaken = getVal(['ACTION TAKEN', 'Action Taken', 'REMARKS'], 'TBD');

      const isRunning = status.toLowerCase().includes('running') || status.toLowerCase().includes('open');
      const isCompleted = status.toLowerCase().includes('complete') || status.toLowerCase().includes('restored');
      const ageing = calculateAgeing(downtime, dateRestored);

      return {
        raw: row,
        ticket,
        status: isRunning ? 'Running' : isCompleted ? 'Completed' : status,
        type,
        province,
        municipality,
        barangay,
        subject,
        nodes,
        downtime,
        etr,
        dateRestored,
        rfo,
        actionTaken,
        ageing,
      };
    });
  }, [databaseRows]);

  // Executive KPI Counts
  const kpiCounts = useMemo(() => {
    let bb = 0;
    let olt = 0;
    let lcp = 0;
    let nap = 0;
    let totalRunning = 0;

    normalizedTickets.forEach((t) => {
      if (t.status === 'Running') {
        totalRunning++;
        if (t.type.includes('BB') || t.type.includes('BACKBONE')) bb++;
        else if (t.type.includes('OLT')) olt++;
        else if (t.type.includes('LCP')) lcp++;
        else if (t.type.includes('NAP')) nap++;
      }
    });

    return { bb, olt, lcp, nap, totalRunning };
  }, [normalizedTickets]);

  // 3-Digit & Multi-field Search Filter
  const filteredTickets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return normalizedTickets.filter((t) => {
      if (selectedProvince !== 'ALL' && !t.province.includes(selectedProvince)) return false;
      if (selectedType !== 'ALL' && !t.type.includes(selectedType)) return false;
      if (selectedStatus !== 'ALL' && t.status !== selectedStatus) return false;

      if (!q) return true;

      // Allows matching "069" for "TT-20261023-00000069", or "LCP", "BULA", etc.
      const ticketLastDigits = t.ticket.replace(/[^0-9]/g, '').slice(-4);
      return (
        t.ticket.toLowerCase().includes(q) ||
        ticketLastDigits.includes(q) ||
        t.subject.toLowerCase().includes(q) ||
        t.nodes.toLowerCase().includes(q) ||
        t.municipality.toLowerCase().includes(q) ||
        t.barangay.toLowerCase().includes(q)
      );
    });
  }, [normalizedTickets, searchQuery, selectedProvince, selectedType, selectedStatus]);

  // Lookup Ticket for Outage Advisory
  const selectedPending = useMemo(() => {
    return normalizedTickets.find((t) => t.ticket === pendingTicketId) || normalizedTickets.find((t) => t.status === 'Running');
  }, [normalizedTickets, pendingTicketId]);

  const selectedCompleted = useMemo(() => {
    return normalizedTickets.find((t) => t.ticket === completedTicketId) || normalizedTickets.find((t) => t.status === 'Completed');
  }, [normalizedTickets, completedTicketId]);

  // Copy Advisory Text Generator
  const copyAdvisoryText = (item, type) => {
    if (!item) return;
    const text = `*OWS OUTAGE ADVISORY (${type})*
Ticket: ${item.ticket}
Status: ${item.status}
Subject: ${item.subject}
Province: ${item.province}
Municipality: ${item.municipality}
Barangay: ${item.barangay}
Type: ${item.type}
Affected nodes/links: ${item.nodes}
${type === 'PENDING' ? `Downtime: ${item.downtime}\nETR: ${item.etr}` : `Uptime: ${item.dateRestored}\nETR: ${item.etr}\nRFO: ${item.rfo}\nAction Taken: ${item.actionTaken}`}
`;
    navigator.clipboard.writeText(text);
    setCopiedState(type);
    setTimeout(() => setCopiedState(null), 2000);
  };

  // CSV Report Exporter
  const exportReportCsv = () => {
    const headers = ['Ticket', 'Status', 'Type', 'Province', 'Municipality', 'Barangay', 'Downtime', 'Date Restored', 'Ageing (Hours)', 'Ageing (Formatted)', 'RFO', 'Action Taken'];
    const rows = filteredTickets.map((t) => [
      `"${t.ticket}"`,
      `"${t.status}"`,
      `"${t.type}"`,
      `"${t.province}"`,
      `"${t.municipality}"`,
      `"${t.barangay}"`,
      `"${t.downtime}"`,
      `"${t.dateRestored}"`,
      t.ageing.totalHours,
      `"${t.ageing.text}"`,
      `"${t.rfo}"`,
      `"${t.actionTaken}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `BICOL_NETWORK_OUTAGE_REPORT_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Corporate Navigation */}
      <header className="bg-slate-900 border-b border-slate-800 px-5 py-3 sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 shadow-md">
        <div className="flex items-center gap-3">
          <div className="bg-sky-600 text-white font-extrabold text-sm px-2.5 py-1 rounded shadow">
            CONVERGE
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
              BICOL NETWORK MONITORING
              <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-2 py-0.5 rounded font-mono">
                LIVE
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Almasor & Camarines Outage Operations • Synced: {lastSynced || 'Fetching...'}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition ${
              autoRefresh
                ? 'bg-emerald-950/60 border-emerald-600 text-emerald-300'
                : 'bg-slate-800 border-slate-700 text-slate-400'
            }`}
          >
            {autoRefresh ? '● Auto-Sync: 30s' : '○ Auto-Sync: Off'}
          </button>

          <button
            onClick={fetchAllSheets}
            className="bg-slate-800 hover:bg-slate-700 text-white text-xs px-3 py-1.5 rounded-lg border border-slate-700 flex items-center gap-1.5 transition active:scale-95"
          >
            <span>↻ Sync Now</span>
          </button>
        </div>
      </header>

      {/* Corporate Tab Switcher */}
      <nav className="bg-slate-900/60 border-b border-slate-800 px-5 flex gap-2 overflow-x-auto text-xs font-semibold uppercase tracking-wider">
        {[
          { id: 'DASHBOARD', label: 'Overview Dashboard' },
          { id: 'DATABASE', label: `Database (${databaseRows.length})` },
          { id: 'GNOC', label: `GNOC Updates (${gnocRows.length})` },
          { id: 'REPORT', label: 'Report Generator & MTTR' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`py-3 px-3 border-b-2 transition whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-sky-500 text-sky-400 font-bold bg-slate-800/40'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Main Workspace */}
      <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
        {/* TAB 1: EXECUTIVE DASHBOARD */}
        {activeTab === 'DASHBOARD' && (
          <>
            {/* KPI Cards (Exact PowerPoint Layout) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* BB DOWN */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow flex flex-col items-center justify-center text-center hover:border-red-500/50 transition">
                <span className="text-xs sm:text-sm font-extrabold uppercase tracking-widest text-red-500 mb-2">
                  BB DOWN
                </span>
                <span className="text-4xl sm:text-6xl font-black text-slate-100 font-mono">
                  {kpiCounts.bb}
                </span>
                <span className="text-[11px] text-slate-500 mt-2">Backbone Links</span>
              </div>

              {/* OLT DOWN */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow flex flex-col items-center justify-center text-center hover:border-amber-500/50 transition">
                <span className="text-xs sm:text-sm font-extrabold uppercase tracking-widest text-amber-500 mb-2">
                  OLT DOWN
                </span>
                <span className="text-4xl sm:text-6xl font-black text-slate-100 font-mono">
                  {kpiCounts.olt}
                </span>
                <span className="text-[11px] text-slate-500 mt-2">Headend Optical Terminals</span>
              </div>

              {/* LCP DOWN */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow flex flex-col items-center justify-center text-center hover:border-sky-500/50 transition">
                <span className="text-xs sm:text-sm font-extrabold uppercase tracking-widest text-sky-400 mb-2">
                  LCP DOWN
                </span>
                <span className="text-4xl sm:text-6xl font-black text-slate-100 font-mono">
                  {kpiCounts.lcp}
                </span>
                <span className="text-[11px] text-slate-500 mt-2">Local Control Points</span>
              </div>

              {/* NAP DOWN */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow flex flex-col items-center justify-center text-center hover:border-emerald-500/50 transition">
                <span className="text-xs sm:text-sm font-extrabold uppercase tracking-widest text-emerald-400 mb-2">
                  NAP DOWN
                </span>
                <span className="text-4xl sm:text-6xl font-black text-slate-100 font-mono">
                  {kpiCounts.nap}
                </span>
                <span className="text-[11px] text-slate-500 mt-2">Network Access Points</span>
              </div>
            </div>

            {/* Outage Advisory Section (PowerPoint Slide 4 Layout) */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow space-y-4">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                    OUTAGE ADVISORY
                  </h3>
                  <p className="text-xs text-slate-400">
                    Select any Ticket ID to autofill advisory details with live XLOOKUP logic
                  </p>
                </div>
                <div className="text-xs text-slate-400 font-mono">
                  Total Active Outages: <strong className="text-red-400">{kpiCounts.totalRunning}</strong>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Pending Advisory Card */}
                <div className="bg-red-950/20 border border-red-900/60 rounded-xl p-4 flex flex-col justify-between">
                  <div>
                    <div className="bg-red-600 text-white font-bold text-center py-1.5 rounded-t-lg text-xs tracking-wider uppercase mb-3">
                      PENDING OUTAGE ADVISORY
                    </div>

                    <div className="mb-3">
                      <label className="text-[11px] text-red-300 font-semibold uppercase block mb-1">
                        Select Pending Ticket:
                      </label>
                      <select
                        value={pendingTicketId}
                        onChange={(e) => setPendingTicketId(e.target.value)}
                        className="w-full bg-slate-900 border border-red-800/80 rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-red-500"
                      >
                        {normalizedTickets
                          .filter((t) => t.status === 'Running')
                          .map((t) => (
                            <option key={t.ticket} value={t.ticket}>
                              {t.ticket} — {t.type} ({t.municipality})
                            </option>
                          ))}
                      </select>
                    </div>

                    {selectedPending ? (
                      <div className="bg-red-950/40 border border-red-900/40 rounded-lg p-3 text-xs space-y-1.5 font-sans">
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Ticket:</span>
                          <span className="font-mono font-bold text-slate-100">{selectedPending.ticket}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Status:</span>
                          <span className="text-red-300 font-bold">Running</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Subject:</span>
                          <span className="text-slate-200 truncate max-w-[240px]">{selectedPending.subject}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Province:</span>
                          <span className="text-slate-200">{selectedPending.province}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Municipality:</span>
                          <span className="text-slate-200">{selectedPending.municipality}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Barangay:</span>
                          <span className="text-slate-200">{selectedPending.barangay}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Type:</span>
                          <span className="font-bold text-amber-400">{selectedPending.type}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Affected nodes/links:</span>
                          <span className="font-mono text-slate-200">{selectedPending.nodes}</span>
                        </div>
                        <div className="flex justify-between border-b border-red-900/40 pb-1">
                          <span className="text-red-400 font-semibold">Downtime:</span>
                          <span className="font-mono text-slate-300">{selectedPending.downtime || '—'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-red-400 font-semibold">ETR:</span>
                          <span className="font-mono text-amber-300">{selectedPending.etr || 'TBD'}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 py-4 text-center">No running ticket selected.</div>
                    )}
                  </div>

                  <button
                    onClick={() => copyAdvisoryText(selectedPending, 'PENDING')}
                    className="mt-4 w-full bg-red-800 hover:bg-red-700 text-white text-xs font-semibold py-2 rounded shadow transition active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    {copiedState === 'PENDING' ? '✓ Advisory Copied to Clipboard!' : '📋 Copy Pending Advisory'}
                  </button>
                </div>

                {/* Completed Advisory Card */}
                <div className="bg-emerald-950/20 border border-emerald-900/60 rounded-xl p-4 flex flex-col justify-between">
                  <div>
                    <div className="bg-emerald-600 text-white font-bold text-center py-1.5 rounded-t-lg text-xs tracking-wider uppercase mb-3">
                      COMPLETED OUTAGE ADVISORY
                    </div>

                    <div className="mb-3">
                      <label className="text-[11px] text-emerald-300 font-semibold uppercase block mb-1">
                        Select Completed Ticket:
                      </label>
                      <select
                        value={completedTicketId}
                        onChange={(e) => setCompletedTicketId(e.target.value)}
                        className="w-full bg-slate-900 border border-emerald-800/80 rounded px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      >
                        {normalizedTickets
                          .filter((t) => t.status === 'Completed')
                          .slice(-40)
                          .map((t) => (
                            <option key={t.ticket} value={t.ticket}>
                              {t.ticket} — {t.type} ({t.municipality})
                            </option>
                          ))}
                      </select>
                    </div>

                    {selectedCompleted ? (
                      <div className="bg-emerald-950/40 border border-emerald-900/40 rounded-lg p-3 text-xs space-y-1.5 font-sans">
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Ticket:</span>
                          <span className="font-mono font-bold text-slate-100">{selectedCompleted.ticket}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Status:</span>
                          <span className="text-emerald-300 font-bold">Completed</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Subject:</span>
                          <span className="text-slate-200 truncate max-w-[240px]">{selectedCompleted.subject}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Province:</span>
                          <span className="text-slate-200">{selectedCompleted.province}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Municipality:</span>
                          <span className="text-slate-200">{selectedCompleted.municipality}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Affected nodes/links:</span>
                          <span className="font-mono text-slate-200">{selectedCompleted.nodes}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">RFO:</span>
                          <span className="text-slate-200">{selectedCompleted.rfo}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Action Taken:</span>
                          <span className="text-slate-200">{selectedCompleted.actionTaken}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/40 pb-1">
                          <span className="text-emerald-400 font-semibold">Uptime:</span>
                          <span className="font-mono text-emerald-300">{selectedCompleted.dateRestored || '—'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-emerald-400 font-semibold">Resolution Time:</span>
                          <span className="font-mono text-slate-200 font-semibold">{selectedCompleted.ageing.text}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 py-4 text-center">No completed ticket selected.</div>
                    )}
                  </div>

                  <button
                    onClick={() => copyAdvisoryText(selectedCompleted, 'COMPLETED')}
                    className="mt-4 w-full bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-semibold py-2 rounded shadow transition active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    {copiedState === 'COMPLETED' ? '✓ Advisory Copied to Clipboard!' : '📋 Copy Completed Advisory'}
                  </button>
                </div>
              </div>
            </div>

            {/* Live Running Outages Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
              <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row justify-between sm:items-center gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
                    RUNNING OUTAGE TICKETS ({normalizedTickets.filter((t) => t.status === 'Running').length})
                  </h3>
                  <p className="text-xs text-slate-400">Current ongoing incidents requiring restoration</p>
                </div>

                <div className="w-full sm:w-64">
                  <input
                    type="text"
                    placeholder="Search last 3 digits (e.g. 184)..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="overflow-x-auto max-h-[360px]">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-950/80 uppercase text-[11px] text-slate-400 sticky top-0 border-b border-slate-800">
                    <tr>
                      <th className="p-3">Ticket</th>
                      <th className="p-3">Type</th>
                      <th className="p-3">Province</th>
                      <th className="p-3">Municipality / Barangay</th>
                      <th className="p-3">Affected Nodes</th>
                      <th className="p-3">Downtime</th>
                      <th className="p-3">Ageing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-sans">
                    {normalizedTickets
                      .filter((t) => t.status === 'Running')
                      .filter((t) => !searchQuery || t.ticket.toLowerCase().includes(searchQuery.toLowerCase()))
                      .map((t, idx) => (
                        <tr key={idx} className="hover:bg-slate-800/50 transition">
                          <td className="p-3 font-mono font-bold text-sky-400">{t.ticket}</td>
                          <td className="p-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                t.type.includes('BB')
                                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                  : t.type.includes('OLT')
                                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                  : t.type.includes('LCP')
                                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              }`}
                            >
                              {t.type}
                            </span>
                          </td>
                          <td className="p-3">{t.province}</td>
                          <td className="p-3">
                            <div className="font-semibold text-slate-200">{t.municipality}</div>
                            <div className="text-[10px] text-slate-500">{t.barangay}</div>
                          </td>
                          <td className="p-3 font-mono text-slate-300">{t.nodes}</td>
                          <td className="p-3 font-mono text-slate-400">{t.downtime || '—'}</td>
                          <td className="p-3 font-mono font-bold text-red-400">{t.ageing.text}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* TAB 2: DATABASE VIEW (COL A TO AD) */}
        {activeTab === 'DATABASE' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow space-y-4 p-4">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                  DATABASE TAB (SPREADSHEET SYNC)
                </h3>
                <p className="text-xs text-slate-400">
                  Showing Columns A through AD ({databaseRows.length} total records)
                </p>
              </div>

              {/* Multi-field 3-digit search */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search last 3 digits or keyword..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500 w-56"
                />
                <button
                  onClick={exportReportCsv}
                  className="bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 rounded-lg shadow font-medium"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto max-h-[580px] border border-slate-800 rounded-lg">
              <table className="w-full text-left text-xs text-slate-300 border-collapse whitespace-nowrap">
                <thead className="bg-slate-950 uppercase text-[10px] text-slate-400 sticky top-0 border-b border-slate-800">
                  <tr>
                    {databaseHeaders.slice(0, 30).map((h, i) => (
                      <th key={i} className="p-2.5 border-r border-slate-800/80">
                        {h || `COL ${i + 1}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {databaseRows
                    .filter((row) => {
                      if (!searchQuery) return true;
                      const q = searchQuery.toLowerCase();
                      return Object.values(row).some((val) => String(val).toLowerCase().includes(q));
                    })
                    .slice(0, 300)
                    .map((row, rIdx) => (
                      <tr key={rIdx} className="hover:bg-slate-800/50 transition">
                        {databaseHeaders.slice(0, 30).map((h, cIdx) => (
                          <td key={cIdx} className="p-2 border-r border-slate-800/60">
                            {row[h] !== undefined && row[h] !== '' ? String(row[h]) : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="text-[11px] text-slate-500 text-right">
              Showing top 300 records for maximum browser rendering speed.
            </div>
          </div>
        )}

        {/* TAB 3: GNOC TAB VIEW */}
        {activeTab === 'GNOC' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow p-4 space-y-4">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                GNOC UPDATES TAB
              </h3>
              <p className="text-xs text-slate-400">
                Live Regional Outage Endorsements & Tickets ({gnocRows.length} records)
              </p>
            </div>

            <div className="overflow-x-auto max-h-[580px] border border-slate-800 rounded-lg">
              <table className="w-full text-left text-xs text-slate-300 border-collapse whitespace-nowrap">
                <thead className="bg-slate-950 uppercase text-[10px] text-slate-400 sticky top-0 border-b border-slate-800">
                  <tr>
                    {gnocHeaders.slice(0, 25).map((h, i) => (
                      <th key={i} className="p-2.5 border-r border-slate-800/80">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                  {gnocRows.slice(0, 300).map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-800/50 transition">
                      {gnocHeaders.slice(0, 25).map((h, cIdx) => (
                        <td key={cIdx} className="p-2 border-r border-slate-800/60">
                          {row[h] !== undefined && row[h] !== '' ? String(row[h]) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: REPORT GENERATOR & MTTR / AGEING */}
        {activeTab === 'REPORT' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow space-y-5">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3 border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-white uppercase tracking-wider">
                  OUTAGE REPORT & AGEING ANALYSIS (MTTR)
                </h3>
                <p className="text-xs text-slate-400">
                  Calculates outage duration: (Date Restored – Downtime) for Completed tickets, or Active Ageing for Running tickets.
                </p>
              </div>

              <button
                onClick={exportReportCsv}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-4 py-2 rounded-lg shadow transition active:scale-95 flex items-center gap-1.5 self-start sm:self-auto"
              >
                <span>📥 Export Full Report (CSV)</span>
              </button>
            </div>

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-950 p-3 rounded-lg border border-slate-800">
              <div>
                <label className="text-[11px] text-slate-400 font-semibold uppercase block mb-1">
                  Status
                </label>
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="Running">Running Only</option>
                  <option value="Completed">Completed Only</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-semibold uppercase block mb-1">
                  Province
                </label>
                <select
                  value={selectedProvince}
                  onChange={(e) => setSelectedProvince(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
                >
                  <option value="ALL">All Provinces</option>
                  <option value="CAMARINES SUR">Camarines Sur</option>
                  <option value="CAMARINES NORTE">Camarines Norte</option>
                  <option value="ALBAY">Albay</option>
                  <option value="SORSOGON">Sorsogon</option>
                  <option value="MASBATE">Masbate</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-semibold uppercase block mb-1">
                  Type
                </label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
                >
                  <option value="ALL">All Types</option>
                  <option value="BB">BB (Backbone)</option>
                  <option value="OLT">OLT</option>
                  <option value="LCP">LCP</option>
                  <option value="NAP">NAP</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 font-semibold uppercase block mb-1">
                  Search Ticket / Node
                </label>
                <input
                  type="text"
                  placeholder="e.g. 184, LIA001..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            {/* Generated Report Table */}
            <div className="overflow-x-auto max-h-[500px] border border-slate-800 rounded-lg">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 uppercase text-[11px] text-slate-400 sticky top-0 border-b border-slate-800">
                  <tr>
                    <th className="p-3">Ticket</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Type</th>
                    <th className="p-3">Province</th>
                    <th className="p-3">Municipality</th>
                    <th className="p-3">Downtime</th>
                    <th className="p-3">Date Restored</th>
                    <th className="p-3">Ageing / MTTR</th>
                    <th className="p-3">RFO</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-sans">
                  {filteredTickets.slice(0, 200).map((t, idx) => (
                    <tr key={idx} className="hover:bg-slate-800/40 transition">
                      <td className="p-3 font-mono font-bold text-sky-400">{t.ticket}</td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            t.status === 'Running'
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="p-3 font-semibold">{t.type}</td>
                      <td className="p-3">{t.province}</td>
                      <td className="p-3">{t.municipality}</td>
                      <td className="p-3 font-mono text-slate-400">{t.downtime || '—'}</td>
                      <td className="p-3 font-mono text-emerald-400">{t.dateRestored || '—'}</td>
                      <td className="p-3 font-mono font-bold">
                        <span className={t.status === 'Running' ? 'text-red-400' : 'text-slate-200'}>
                          {t.ageing.text}
                        </span>
                      </td>
                      <td className="p-3 text-slate-400 truncate max-w-[200px]">{t.rfo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
