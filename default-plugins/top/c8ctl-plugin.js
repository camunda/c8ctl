/**
 * c8ctl-plugin-top
 *
 * Interactive process-instance monitor — like htop for Camunda 8.
 *
 * Shows running process instances in a full-screen terminal UI.
 * Use the arrow keys to navigate the list and Enter to drill into a
 * selected instance for full details.
 *
 * Usage:
 *   c8 top
 *   c8 top --all                     # include all states, not just ACTIVE
 *   c8 top --refresh=10              # auto-refresh every 10 s (default: 5)
 *   c8 top --profile=<name>          # use a named c8ctl profile
 *
 * Keyboard shortcuts (list view):
 *   ↑ / ↓         move selection
 *   Page Up/Down  move selection by a page
 *   Home / End    jump to first / last
 *   Enter         open detail view for selected instance
 *   r             refresh now
 *   q / Ctrl+C    quit
 *
 * Keyboard shortcuts (detail view):
 *   q / Escape    back to list
 *   r             refresh detail
 *   Ctrl+C        quit
 */

import readline from 'node:readline';

/* ─── ANSI helpers ────────────────────────────────────────────────────────── */
const R   = '\x1b[0m';   // reset
const B   = '\x1b[1m';   // bold
const D   = '\x1b[2m';   // dim
const IV  = '\x1b[7m';   // reverse / highlight
const RE  = '\x1b[31m';  // red
const GR  = '\x1b[32m';  // green
const YL  = '\x1b[33m';  // yellow
const BL  = '\x1b[34m';  // blue
const CY  = '\x1b[36m';  // cyan
const WH  = '\x1b[37m';  // white

const CLEAR       = '\x1b[2J';
const GOTO_HOME   = '\x1b[H';
const ERASE_DOWN  = '\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** Colour for process-instance state string */
const stateColor = s => {
  switch (String(s ?? '').toUpperCase()) {
    case 'ACTIVE':     return GR;
    case 'COMPLETED':  return CY;
    case 'CANCELED':
    case 'TERMINATED': return D;
    default:           return WH;
  }
};

/** Pad or truncate `v` to exactly `w` visible characters */
const cell = (v, w) => {
  const s = v == null ? '' : String(v);
  return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
};

/** Format an ISO/date string to 'YYYY-MM-DD HH:MM:SS' (19 chars) */
const fmt = d => {
  if (!d) return ' '.repeat(19);
  try { return new Date(d).toISOString().replace('T', ' ').slice(0, 19); }
  catch { return String(d).slice(0, 19).padEnd(19); }
};

/* ─── Plugin exports ──────────────────────────────────────────────────────── */

export const metadata = {
  name:        'c8ctl-plugin-top',
  description: 'Interactive process-instance monitor — like htop for Camunda 8',
  commands: {
    top: { description: 'Interactive process-instance monitor (htop-style)' },
  },
};

export const commands = {
  top: async (args) => {
    /* ── argument parsing ────────────────────────────────────────────────── */
    let refreshSecs = 5;
    let profileFlag;
    let showAll = false;

    for (const a of (args ?? [])) {
      if (a === '--all' || a === '-a')          { showAll = true; continue; }
      if (a.startsWith('--refresh='))           { refreshSecs = Math.max(1, parseInt(a.slice(10), 10) || 5); continue; }
      if (a.startsWith('--profile='))           { profileFlag = a.slice(10); continue; }
    }

    /* ── TTY guard ───────────────────────────────────────────────────────── */
    if (!process.stdout.isTTY) {
      console.error('c8 top requires an interactive terminal.\nRun it directly in a terminal, not in a pipe.');
      process.exit(1);
    }

    /* ── shared mutable state ─────────────────────────────────────────────── */
    const s = {
      instances: [],   // array of process-instance objects
      sel:       0,    // selected row index (0-based)
      scroll:    0,    // index of first visible row
      view:      'list',  // 'list' | 'detail'
      detail:    null, // enriched detail object for selected instance
      loading:   false,
      error:     null,
      lastAt:    null, // Date of last successful list fetch
      timer:     null, // auto-refresh interval handle
    };

    const client = (globalThis.c8ctl).createClient(profileFlag);
    const out    = v => process.stdout.write(v);

    /* ── terminal dimensions (updated on resize) ─────────────────────────── */
    let W = process.stdout.columns || 80;
    let H = process.stdout.rows    || 24;

    /** Number of instance rows visible between header and footer */
    const listH = () => Math.max(1, H - 7);

    /* ── column widths ────────────────────────────────────────────────────── */
    // Layout per row (incident mark = 1 char, then body):
    //   sp num  sp key   sp processId  sp state  sp ver  sp startDate
    //   1  5    2  20    2  24         2  10      2  4    2  19
    // = ~91 visible chars (truncated to terminal width automatically)
    const CW = { num: 5, key: 20, pid: 24, state: 10, ver: 4 };

    /* ── drawing primitives ───────────────────────────────────────────────── */
    const hr = (ch = '─') => D + ch.repeat(W) + R + '\n';

    const renderList = () => {
      const { instances, sel, loading, error, lastAt } = s;
      const vh = listH();

      // Keep selection visible
      if (sel < s.scroll) s.scroll = sel;
      else if (sel >= s.scroll + vh) s.scroll = sel - vh + 1;
      const sc = s.scroll;

      // ── title bar
      const ts    = lastAt ? fmt(lastAt.toISOString()) : 'never';
      const title = B + BL + 'c8 top' + R + '  Camunda 8 Process Monitor';
      const tsr   = D + 'last refresh: ' + ts + R;
      const gap   = Math.max(1, W - 6 - 23 - 14 - ts.length);
      out(title + ' '.repeat(gap) + tsr + '\n');
      out(hr());

      // ── column headers (2 leading spaces: 1 incident col + 1 row-body indent)
      out(
        B
        + '  ' + cell('#',          CW.num)
        + '  ' + cell('Key',        CW.key)
        + '  ' + cell('Process ID', CW.pid)
        + '  ' + cell('State',      CW.state)
        + '  ' + cell('Ver',        CW.ver)
        + '  Start Date'
        + R + '\n',
      );
      out(hr());

      // ── instance rows
      if (loading && instances.length === 0) {
        out(CY + '  Loading…' + R + '\n');
        for (let i = 1; i < vh; i++) out('\n');
      } else if (instances.length === 0) {
        const hint = showAll
          ? 'No process instances found.'
          : 'No active process instances found.  (use --all for all states)';
        out(D + '  ' + hint + R + '\n');
        for (let i = 1; i < vh; i++) out('\n');
      } else {
        for (let i = 0; i < vh; i++) {
          const idx = sc + i;
          if (idx >= instances.length) { out('\n'); continue; }

          const pi  = instances[idx];
          const key = pi.processInstanceKey ?? pi.key ?? '';
          const pid = pi.processDefinitionId ?? '';
          const st  = pi.state ?? '';
          const ver = pi.processDefinitionVersion ?? pi.version ?? '';
          const inc = pi.hasIncident;
          const isSel = idx === sel;

          const incMark  = inc ? YL + '⚠' + R : ' ';
          const rowColor = isSel ? IV : stateColor(st);
          const rowBody  =
            ' '  + cell(idx + 1, CW.num)
            + '  ' + cell(key,     CW.key)
            + '  ' + cell(pid,     CW.pid)
            + '  ' + cell(st,      CW.state)
            + '  ' + cell(ver,     CW.ver)
            + '  ' + fmt(pi.startDate);

          out(incMark + rowColor + rowBody + R + '\n');
        }
      }

      // ── footer
      out(hr());
      const ldPart  = loading  ? ' ' + YL + ' Refreshing…' + R : '';
      const errPart = error    ? ' ' + RE + ' ' + error + R    : '';
      out('  Instances: ' + instances.length + ldPart + errPart + '\n');
      out(D + '  [↑↓] Navigate  [Enter] Details  [r] Refresh  [q/^C] Quit' + R + '\n');
    };

    const renderDetail = () => {
      const { detail, loading, error, instances, sel } = s;
      const pi  = instances[sel];
      const key = pi?.processInstanceKey ?? pi?.key ?? '?';

      // ── title bar
      out(B + BL + 'c8 top' + R + '  Process Instance ' + B + key + R + '\n');
      out(hr());

      if (loading && !detail) {
        out(CY + '  Loading details…' + R + '\n');
      } else if (error && !detail) {
        out(RE + '  Error: ' + error + R + '\n');
      } else if (detail) {
        const fields = [
          ['Key',        detail.processInstanceKey ?? detail.key],
          ['Process ID', detail.processDefinitionId],
          ['State',      stateColor(detail.state) + (detail.state ?? '') + R],
          ['Version',    detail.processDefinitionVersion ?? detail.version],
          ['Tenant',     detail.tenantId],
          ['Start Date', fmt(detail.startDate)],
          ['End Date',   detail.endDate ? fmt(detail.endDate) : D + '─' + R],
          ['Incident',   detail.hasIncident ? YL + 'Yes' + R : D + 'No' + R],
        ];

        for (const [lbl, val] of fields) {
          out('  ' + B + cell(lbl + ':', 14) + R + ' ' + (val ?? D + '─' + R) + '\n');
        }

        const vars = detail.variables ?? [];
        out('\n');
        if (vars.length > 0) {
          out(B + '  Variables' + R + '\n');
          out(hr());
          const maxV = Math.max(1, H - fields.length - 10);
          const show = vars.slice(0, maxV);
          for (const v of show) {
            const raw = v.value !== undefined ? JSON.stringify(v.value) : '─';
            const val = raw.length > W - 24 ? raw.slice(0, W - 27) + '…' : raw;
            out('    ' + B + cell((v.name ?? '') + ':', 18) + R + ' ' + val + '\n');
          }
          if (vars.length > maxV) {
            out(D + '    … and ' + (vars.length - maxV) + ' more variable(s)' + R + '\n');
          }
        } else {
          out(D + '  (no variables)' + R + '\n');
        }
      }

      out('\n');
      out(hr());
      out(D + '  [q / Esc] Back to list  [r] Refresh  [^C] Quit' + R + '\n');
    };

    const render = () => {
      W = process.stdout.columns || 80;
      H = process.stdout.rows    || 24;
      out(GOTO_HOME + ERASE_DOWN);
      if (s.view === 'list') renderList();
      else renderDetail();
    };

    /* ── API calls ────────────────────────────────────────────────────────── */
    const fetchList = async () => {
      s.loading = true;
      render();
      try {
        const filter = showAll ? {} : { state: 'ACTIVE' };
        const res = await client.searchProcessInstances(
          { filter, page: { limit: 500 } },
          { consistency: { waitUpToMs: 0 } },
        );
        s.instances = res.items ?? [];
        s.lastAt    = new Date();
        s.error     = null;
        if (s.sel >= s.instances.length) {
          s.sel = Math.max(0, s.instances.length - 1);
        }
      } catch (e) {
        s.error = String(e?.message ?? e);
      } finally {
        s.loading = false;
        render();
      }
    };

    const fetchDetail = async () => {
      const pi = s.instances[s.sel];
      if (!pi) return;
      const piKey = pi.processInstanceKey ?? pi.key;
      s.loading = true;
      render();
      try {
        const detail = await client.getProcessInstance(
          { processInstanceKey: piKey },
          { consistency: { waitUpToMs: 0 } },
        );
        let variables = [];
        try {
          const vr = await client.searchVariables(
            { filter: { processInstanceKey: piKey }, truncateValues: false },
            { consistency: { waitUpToMs: 0 } },
          );
          variables = vr.items ?? [];
        } catch { /* variables are optional */ }
        s.detail = { ...detail, variables };
        s.error  = null;
      } catch (e) {
        s.error  = String(e?.message ?? e);
        s.detail = null;
      } finally {
        s.loading = false;
        render();
      }
    };

    /* ── auto-refresh timer ───────────────────────────────────────────────── */
    s.timer = setInterval(() => {
      if (s.view === 'list') fetchList();
    }, refreshSecs * 1_000);

    /* ── cleanup ──────────────────────────────────────────────────────────── */
    const cleanup = () => {
      clearInterval(s.timer);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      out(CLEAR + GOTO_HOME + SHOW_CURSOR);
    };

    const doExit = (code = 0) => { cleanup(); process.exit(code); };

    /* ── keyboard input ───────────────────────────────────────────────────── */
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    process.stdin.on('keypress', async (_, key) => {
      if (!key) return;

      // Ctrl+C always quits regardless of view
      if (key.ctrl && key.name === 'c') { doExit(0); return; }

      if (s.view === 'list') {
        switch (key.name) {
          case 'q':
            doExit(0);
            break;
          case 'up':
          case 'k':
            if (s.sel > 0) { s.sel--; render(); }
            break;
          case 'down':
          case 'j':
            if (s.sel < s.instances.length - 1) { s.sel++; render(); }
            break;
          case 'pageup':
            s.sel = Math.max(0, s.sel - listH());
            render();
            break;
          case 'pagedown':
            s.sel = Math.min(s.instances.length - 1, s.sel + listH());
            render();
            break;
          case 'home':
            s.sel = 0; s.scroll = 0; render();
            break;
          case 'end':
            s.sel = Math.max(0, s.instances.length - 1); render();
            break;
          case 'return':
          case 'enter':
            if (s.instances.length > 0) {
              s.view   = 'detail';
              s.detail = null;
              render();
              await fetchDetail();
            }
            break;
          case 'r':
            await fetchList();
            break;
        }
      } else { // detail view
        switch (key.name) {
          case 'q':
          case 'escape':
            s.view = 'list'; s.detail = null; render();
            break;
          case 'r':
            await fetchDetail();
            break;
        }
      }
    });

    /* ── terminal resize ──────────────────────────────────────────────────── */
    process.stdout.on('resize', render);

    /* ── SIGINT safety net ────────────────────────────────────────────────── */
    process.once('SIGINT', () => doExit(0));

    /* ── initial paint ────────────────────────────────────────────────────── */
    out(HIDE_CURSOR + CLEAR + GOTO_HOME);
    await fetchList();

    /* ── keep the event loop alive until stdin closes ─────────────────────── */
    await new Promise(resolve => process.stdin.once('close', resolve));
  },
};
