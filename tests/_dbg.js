var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = path.join(__dirname, '..', 'src', 'background.js');
var src = fs.readFileSync(SRC, 'utf8');
var st = { sent: [], downloads: [], session: {}, listeners: {}, nextId: 1 };
st.chrome = {
  downloads: {
    onChanged: { addListener: function (f) { st.listeners.dc = f; } },
    download: function (o) {
      console.log('DOWNLOAD CALLED', o.url);
      st.downloads.push(o);
      var id = st.nextId++;
      setImmediate(function () { st.listeners.dc({ id: id, state: { current: 'complete' } }); });
      return Promise.resolve(id);
    },
    search: function (q, cb) { cb([]); }
  },
  runtime: {
    onMessage: { addListener: function (f) { st.listeners.message = f; } },
    onInstalled: { addListener: function () {} },
    getManifest: function () { return { version: '1.0.0' }; }
  },
  storage: {
    session: {
      get: function (k, cb) { var o = {}; o[k] = st.session[k]; cb(o); },
      set: function (o, cb) { Object.assign(st.session, o); cb && cb(); },
      remove: function (k, cb) { delete st.session[k]; cb && cb(); }
    },
    local: { get: function (k, cb) { cb({}); }, set: function (o, cb) { cb && cb(); } }
  },
  tabs: { sendMessage: function (t, m, cb) { console.log('NOTIFY tab=' + t, m.type, JSON.stringify(m.payload)); st.sent.push({ t: t, m: m }); cb && cb(); } }
};
var sandbox = {
  chrome: st.chrome, console: console, Promise: Promise,
  setTimeout: function (fn, ms) { console.log('setTimeout', ms); if (ms >= 1200000) return 0; setImmediate(fn); return 0; },
  clearTimeout: function () {}, setInterval: function () { return 0; }
};
var c = vm.createContext(sandbox);
vm.runInContext(src, c, { filename: SRC });
console.log('listener?', typeof st.listeners.message);
st.listeners.message(
  { type: 'DOWNLOAD_BATCH', payload: { tasks: [{ kind: 'image', name: '1.jpg', url: 'https://x/a', dir: 'dir', fallbacks: [] }], noteId: 'n' } },
  { tab: { id: 777 } },
  function (x) { console.log('RESP', JSON.stringify(x)); }
);
setTimeout(function () { console.log('FINAL downloads=', st.downloads.length, 'sent=', st.sent.length); }, 300);
