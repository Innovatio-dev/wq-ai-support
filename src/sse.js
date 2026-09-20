// Tiny Server-Sent Events helper. Events used by both agents:
//   status | delta | ticket_draft | usage | done | error
export function openSse(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx / some PaaS edges)
  });
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    get closed() { return closed; },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!closed) res.end();
      closed = true;
    },
  };
}
