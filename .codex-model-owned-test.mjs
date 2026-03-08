const res = await fetch('http://127.0.0.1:8787/qq-bridge/inbound', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    chat: { id: '523528830', type: 'private', name: '猫七街' },
    sender: { id: '523528830', name: '猫七街' },
    message: { id: 'codex-model-owned-1', text: '查看模型', isFromMe: false },
    timestamp: '2026-03-09T02:55:00.000Z'
  })
});
console.log(await res.text());
