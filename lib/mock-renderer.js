const fs = require('fs');
const path = require('path');

// Parse a Python file for Streamlit calls and generate mock HTML
function parseStreamlit(source) {
  const components = [];

  // Extract st.set_page_config
  const configMatch = source.match(/st\.set_page_config\([^)]*page_title\s*=\s*["']([^"']+)["']/);
  const pageTitle = configMatch?.[1] || 'Streamlit App';
  const wideLayout = /layout\s*=\s*["']wide["']/.test(source);

  // Match st.* calls with string arguments
  const patterns = [
    { re: /st\.title\(\s*["'](.+?)["']/g, type: 'title' },
    { re: /st\.header\(\s*["'](.+?)["']/g, type: 'header' },
    { re: /st\.subheader\(\s*["'](.+?)["']/g, type: 'subheader' },
    { re: /st\.write\(\s*["'](.+?)["']/g, type: 'write' },
    { re: /st\.markdown\(\s*["']{1,3}(.+?)["']{1,3}/gs, type: 'markdown' },
    { re: /st\.text_area\(\s*["'](.+?)["']/g, type: 'text_area' },
    { re: /st\.text_input\(\s*["'](.+?)["']/g, type: 'text_input' },
    { re: /st\.number_input\(\s*["'](.+?)["']/g, type: 'number_input' },
    { re: /st\.selectbox\(\s*["'](.+?)["']\s*,\s*\[(.+?)\]/g, type: 'selectbox' },
    { re: /st\.multiselect\(\s*["'](.+?)["']/g, type: 'multiselect' },
    { re: /st\.button\(\s*["'](.+?)["']/g, type: 'button' },
    { re: /st\.checkbox\(\s*["'](.+?)["']/g, type: 'checkbox' },
    { re: /st\.slider\(\s*["'](.+?)["']/g, type: 'slider' },
    { re: /st\.file_uploader\(\s*["'](.+?)["']/g, type: 'file_uploader' },
    { re: /st\.tabs\(\s*\[(.+?)\]/g, type: 'tabs' },
    { re: /st\.info\(\s*["'](.+?)["']/g, type: 'info' },
    { re: /st\.warning\(\s*["'](.+?)["']/g, type: 'warning' },
    { re: /st\.success\(\s*["'](.+?)["']/g, type: 'success' },
    { re: /st\.error\(\s*["'](.+?)["']/g, type: 'error' },
    { re: /st\.dataframe/g, type: 'dataframe' },
    { re: /st\.json/g, type: 'json_display' },
    { re: /st\.columns\((\d+)\)/g, type: 'columns' },
    { re: /st\.expander\(\s*f?["'](.+?)["']/g, type: 'expander' },
    { re: /st\.sidebar/g, type: 'sidebar' },
    { re: /st\.spinner\(\s*["'](.+?)["']/g, type: 'spinner' },
  ];

  // Find positions of all matches to maintain order
  const allMatches = [];
  for (const { re, type } of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      allMatches.push({ type, text: m[1] || '', extra: m[2] || '', pos: m.index });
    }
  }
  allMatches.sort((a, b) => a.pos - b.pos);

  // Deduplicate by position proximity (some regexes overlap)
  const seen = new Set();
  for (const m of allMatches) {
    const key = `${m.type}:${m.pos}`;
    if (!seen.has(key)) {
      seen.add(key);
      components.push(m);
    }
  }

  return { pageTitle, wideLayout, components, hasSidebar: /st\.sidebar/.test(source) };
}

// Generate mock Streamlit HTML from parsed components
function renderStreamlitHTML(parsed) {
  const { pageTitle, components, hasSidebar } = parsed;

  const renderComponent = (c) => {
    const esc = s => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    switch (c.type) {
      case 'title': return `<h1 style="font-size:32px;font-weight:700;margin:16px 0 8px">${esc(c.text)}</h1>`;
      case 'header': return `<h2 style="font-size:24px;font-weight:600;margin:16px 0 8px">${esc(c.text)}</h2>`;
      case 'subheader': return `<h3 style="font-size:20px;font-weight:600;margin:14px 0 6px;color:#333">${esc(c.text)}</h3>`;
      case 'write': return `<p style="margin:4px 0;color:#444">${esc(c.text)}</p>`;
      case 'markdown': {
        const text = c.text.replace(/^#+\s*/gm, '').replace(/\n/g, '<br>').slice(0, 200);
        return `<div style="margin:8px 0;color:#555;font-size:14px">${text}</div>`;
      }
      case 'text_area': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:100%;height:120px;border:1px solid #ddd;border-radius:6px;background:#fafafa"></div></div>`;
      case 'text_input': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:100%;height:38px;border:1px solid #ddd;border-radius:6px;background:#fafafa"></div></div>`;
      case 'number_input': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:120px;height:38px;border:1px solid #ddd;border-radius:6px;background:#fafafa;display:flex;align-items:center;padding:0 12px;color:#666">0</div></div>`;
      case 'selectbox': {
        const options = c.extra.replace(/["']/g, '').split(',').map(s => s.trim()).slice(0, 4);
        return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:100%;height:38px;border:1px solid #ddd;border-radius:6px;background:#fafafa;display:flex;align-items:center;padding:0 12px;color:#333;justify-content:space-between">${esc(options[0] || 'Select...')}<span style="color:#999">▾</span></div></div>`;
      }
      case 'multiselect': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:100%;min-height:38px;border:1px solid #ddd;border-radius:6px;background:#fafafa;padding:6px 12px;color:#999">Choose options...</div></div>`;
      case 'button': return `<button style="margin:8px 4px 8px 0;padding:8px 20px;background:#ff4b4b;color:white;border:none;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer">${esc(c.text)}</button>`;
      case 'checkbox': return `<div style="margin:6px 0;display:flex;align-items:center;gap:8px"><div style="width:18px;height:18px;border:2px solid #ccc;border-radius:4px;flex-shrink:0"></div><span style="font-size:14px;color:#333">${esc(c.text)}</span></div>`;
      case 'slider': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:8px">${esc(c.text)}</label><div style="width:100%;height:6px;background:#eee;border-radius:3px;position:relative"><div style="width:40%;height:6px;background:#ff4b4b;border-radius:3px"></div><div style="position:absolute;top:-6px;left:40%;width:18px;height:18px;background:#ff4b4b;border-radius:50%"></div></div></div>`;
      case 'file_uploader': return `<div style="margin:10px 0"><label style="font-size:14px;font-weight:500;color:#333;display:block;margin-bottom:4px">${esc(c.text)}</label><div style="width:100%;height:80px;border:1px dashed #ccc;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#999;font-size:13px">Drag and drop file here</div></div>`;
      case 'tabs': {
        const tabs = c.text.replace(/["']/g, '').split(',').map(s => s.trim());
        return `<div style="margin:12px 0;display:flex;border-bottom:2px solid #eee">${tabs.map((t, i) => `<div style="padding:8px 16px;font-size:14px;font-weight:500;${i === 0 ? 'border-bottom:2px solid #ff4b4b;color:#ff4b4b;margin-bottom:-2px' : 'color:#999'}">${esc(t)}</div>`).join('')}</div>`;
      }
      case 'info': return `<div style="margin:8px 0;padding:12px 16px;background:#e8f0fe;border-radius:6px;font-size:14px;color:#1a73e8">${esc(c.text).slice(0, 100)}</div>`;
      case 'warning': return `<div style="margin:8px 0;padding:12px 16px;background:#fef3cd;border-radius:6px;font-size:14px;color:#856404">${esc(c.text).slice(0, 100)}</div>`;
      case 'success': return `<div style="margin:8px 0;padding:12px 16px;background:#d4edda;border-radius:6px;font-size:14px;color:#155724">${esc(c.text).slice(0, 100)}</div>`;
      case 'error': return `<div style="margin:8px 0;padding:12px 16px;background:#f8d7da;border-radius:6px;font-size:14px;color:#721c24">${esc(c.text).slice(0, 100)}</div>`;
      case 'dataframe': return `<div style="margin:10px 0;border:1px solid #eee;border-radius:6px;overflow:hidden"><div style="display:grid;grid-template-columns:repeat(4,1fr);background:#fafafa;border-bottom:1px solid #eee">${['Col A','Col B','Col C','Col D'].map(h => `<div style="padding:8px 12px;font-size:12px;font-weight:600;color:#555">${h}</div>`).join('')}</div>${[1,2,3].map(r => `<div style="display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #f5f5f5">${[1,2,3,4].map(c => `<div style="padding:6px 12px;font-size:13px;color:#444">${(r*c*17)%100}</div>`).join('')}</div>`).join('')}</div>`;
      case 'json_display': return `<div style="margin:10px 0;padding:12px;background:#1e1e1e;border-radius:6px;font-family:monospace;font-size:12px;color:#9cdcfe">{ "status": "completed", "id": "ft-abc123" }</div>`;
      case 'columns': return ''; // Layout hint, skip
      case 'expander': return `<div style="margin:8px 0;border:1px solid #eee;border-radius:6px;padding:10px 16px"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:14px;font-weight:500">${esc(c.text).slice(0, 60)}</span><span style="color:#999">▸</span></div></div>`;
      case 'sidebar': return ''; // Handled at layout level
      case 'spinner': return '';
      default: return '';
    }
  };

  // Limit to first ~25 components to keep the preview focused
  const visibleComponents = components.filter(c => c.type !== 'sidebar' && c.type !== 'spinner' && c.type !== 'columns').slice(0, 25);

  const body = visibleComponents.map(renderComponent).filter(Boolean).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Source Sans Pro', -apple-system, sans-serif; background: #fff; color: #262730; }
  .st-header { background: #fff; border-bottom: 1px solid #e6e6e6; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
  .st-header .logo { width: 24px; height: 24px; background: #ff4b4b; border-radius: 4px; }
  .st-header .app-name { font-size: 14px; font-weight: 600; color: #555; }
  .st-sidebar { width: 260px; background: #f8f9fa; border-right: 1px solid #e6e6e6; padding: 20px; position: absolute; left: 0; top: 48px; bottom: 0; }
  .st-sidebar .sidebar-title { font-size: 13px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }
  .st-main { padding: 32px 48px; ${hasSidebar ? 'margin-left: 260px;' : ''} max-width: 800px; }
  .st-toolbar { position: absolute; top: 12px; right: 16px; display: flex; gap: 8px; }
  .st-toolbar .btn { width: 32px; height: 32px; border-radius: 6px; border: 1px solid #e6e6e6; background: #fff; display: flex; align-items: center; justify-content: center; color: #999; font-size: 14px; }
</style></head>
<body>
  <div class="st-header">
    <div class="logo"></div>
    <div class="app-name">${pageTitle}</div>
  </div>
  <div class="st-toolbar">
    <div class="btn">⋮</div>
    <div class="btn">↗</div>
  </div>
  ${hasSidebar ? '<div class="st-sidebar"><div class="sidebar-title">Navigation</div></div>' : ''}
  <div class="st-main">${body}</div>
</body></html>`;
}

// Parse Tkinter app and generate mock HTML
function renderTkinterHTML(source, appName) {
  const title = source.match(/self\.title\(\s*["'](.+?)["']/)?.[1] || appName;
  const geometry = source.match(/geometry\(\s*["'](\d+)x(\d+)["']/);
  const labelFrames = [...source.matchAll(/LabelFrame\([^,]+,\s*text\s*=\s*["'](.+?)["']/g)].map(m => m[1]);
  const treeviews = [...source.matchAll(/columns\s*=\s*\((.+?)\)/g)].map(m => m[1].replace(/["']/g, '').split(',').map(s => s.trim()));
  const comboboxes = [...source.matchAll(/Combobox\([^)]*\)/g)].length;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f0f0f0; }
  .titlebar { background: #e8e8e8; border-bottom: 1px solid #ccc; padding: 6px 12px; display: flex; align-items: center; gap: 8px; }
  .titlebar .dots { display: flex; gap: 6px; }
  .titlebar .dot { width: 12px; height: 12px; border-radius: 50%; }
  .titlebar .dot.r { background: #ff5f57; }
  .titlebar .dot.y { background: #fdbc40; }
  .titlebar .dot.g { background: #27ca40; }
  .titlebar .title { flex: 1; text-align: center; font-size: 13px; color: #333; }
  .content { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .frame { border: 1px solid #ccc; border-radius: 4px; padding: 12px; background: #f8f8f8; }
  .frame-title { font-size: 12px; color: #555; margin-bottom: 8px; font-weight: 600; background: #f0f0f0; display: inline-block; padding: 0 4px; position: relative; top: -20px; margin-bottom: -12px; }
  .tree { border: 1px solid #ddd; background: #fff; }
  .tree-header { display: grid; grid-template-columns: repeat(4, 1fr); background: #e8e8e8; border-bottom: 1px solid #ddd; }
  .tree-header div { padding: 4px 8px; font-size: 11px; font-weight: 600; color: #444; }
  .tree-row { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #f0f0f0; }
  .tree-row div { padding: 3px 8px; font-size: 11px; color: #555; }
  .tree-row:nth-child(odd) { background: #fafafa; }
  .combo { height: 24px; border: 1px solid #ccc; border-radius: 3px; background: #fff; padding: 0 8px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; color: #333; width: 200px; }
</style></head>
<body>
  <div class="titlebar">
    <div class="dots"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div></div>
    <div class="title">${title}</div>
  </div>
  <div class="content">
    ${labelFrames.map(name => `<div class="frame"><div class="frame-title">${name}</div>
      <div class="tree"><div class="tree-header">${['Name','Status','Date','Value'].map(h => `<div>${h}</div>`).join('')}</div>${[1,2,3].map(r => `<div class="tree-row">${['Item '+r, 'Active', '2026-03', r*17+'%'].map(c => `<div>${c}</div>`).join('')}</div>`).join('')}</div>
      ${comboboxes > 0 ? '<div style="margin-top:8px"><div class="combo">Select... <span style="color:#999">▾</span></div></div>' : ''}
    </div>`).join('\n')}
  </div>
</body></html>`;
}

// Parse Flask app and generate mock HTML
function renderFlaskHTML(source, appName) {
  const routes = [...source.matchAll(/@app\.route\(\s*["'](.+?)["']/g)].map(m => m[1]);
  const templates = [...source.matchAll(/render_template\(\s*["'](.+?)["']/g)].map(m => m[1]);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #fff; }
  .navbar { background: #343a40; padding: 12px 24px; color: #fff; font-size: 16px; font-weight: 600; }
  .content { padding: 32px 48px; max-width: 800px; }
  h1 { font-size: 28px; margin-bottom: 16px; color: #212529; }
  .route-list { margin: 16px 0; }
  .route { padding: 8px 16px; background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; margin: 6px 0; font-family: monospace; font-size: 14px; color: #495057; display: flex; align-items: center; gap: 8px; }
  .route .method { background: #28a745; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .route .method.post { background: #ffc107; color: #212529; }
</style></head>
<body>
  <div class="navbar">${appName}</div>
  <div class="content">
    <h1>${appName}</h1>
    <div class="route-list">
      ${routes.map(r => {
        const isPost = source.includes(`'${r}'`) && source.includes("POST");
        return `<div class="route"><span class="method ${isPost ? 'post' : ''}">GET</span>${r}</div>`;
      }).join('\n')}
    </div>
    ${templates.length > 0 ? `<p style="margin-top:16px;color:#6c757d;font-size:14px">Templates: ${templates.join(', ')}</p>` : ''}
  </div>
</body></html>`;
}

// Main entry: detect framework and generate mock HTML
function generateMockHTML(projectDir, projectName) {
  // Find Python files
  const pyFiles = [];
  try {
    for (const f of fs.readdirSync(projectDir)) {
      if (f.endsWith('.py')) pyFiles.push(f);
    }
  } catch { return null; }

  if (pyFiles.length === 0) return null;

  // Check each file for UI frameworks
  for (const pyFile of pyFiles) {
    const filePath = path.join(projectDir, pyFile);
    const source = fs.readFileSync(filePath, 'utf8');

    if (/import\s+streamlit|from\s+streamlit/.test(source)) {
      const parsed = parseStreamlit(source);
      if (parsed.components.length > 0) {
        return renderStreamlitHTML(parsed);
      }
    }

    if (/from\s+flask\s+import|import\s+flask/.test(source)) {
      return renderFlaskHTML(source, projectName);
    }

    if (/import\s+tkinter|from\s+tkinter/.test(source)) {
      return renderTkinterHTML(source, projectName);
    }
  }

  return null;
}

module.exports = { generateMockHTML, parseStreamlit, renderStreamlitHTML };
