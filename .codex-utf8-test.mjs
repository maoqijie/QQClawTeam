const res = await fetch('http://127.0.0.1:8787/qq-bridge/inbound', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chat: { id: '523528830', type: 'private', name: '猫七街' },
    sender: { id: '523528830', name: '猫七街' },
    message: { id: 'codex-diag-utf8-file-3', text: '增加一个QQ号用来给你调度', isFromMe: false },
    timestamp: '2026-03-08T10:12:00.000Z'
  })
});
console.log(await res.text());
