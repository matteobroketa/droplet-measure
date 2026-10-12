const target = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(item => item.url === 'http://127.0.0.1:8000/index.html');
if (!target) throw new Error('No local Droplet Measure browser target found.');
const expression = Buffer.from(process.env.DM_EXPRESSION_B64 || '', 'base64').toString('utf8');
if (!expression) throw new Error('DM_EXPRESSION_B64 is empty.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
let commandId = 0;
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id === 1) {
    process.stdout.write(JSON.stringify(message.result?.exceptionDetails ? message.result : message.result?.result?.value ?? message.result ?? message) + '\n');
    process.exit(message.result?.exceptionDetails ? 1 : 0);
  }
};
socket.onerror = error => { console.error(error); process.exit(1); };
socket.onopen = () => socket.send(JSON.stringify({id: ++commandId, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
