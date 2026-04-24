/**
 * VOD Desk — Local Audio Proxy (v2)
 * =================================
 *
 * Fetches Twitch VOD audio on behalf of the browser, with two modes:
 *
 *   /proxy?url=<url>        Raw byte passthrough (for playlists, GQL, etc.)
 *   /proxy-audio?url=<url>  Same but unwraps MPEG-TS containers to ADTS AAC,
 *                           which the browser can actually decode reliably.
 *
 * HOW TO RUN:
 *   1. Install Node.js from https://nodejs.org (LTS version, 18+).
 *   2. Put this file in a folder.
 *   3. Open PowerShell in that folder.
 *   4. Run:  node proxy.js
 *   5. Leave the window open while you use the VOD Desk app.
 *
 * NO NPM INSTALL NEEDED — everything is built in, zero dependencies.
 *
 * WHAT IT DOES NOT DO:
 *   - Store anything
 *   - Read your Twitch account
 *   - Accept connections from outside your computer (localhost only)
 */

const http = require('http');

const PORT = 7777;
const HOST = '127.0.0.1';

// Only allow proxying to these Twitch-owned domains.
const ALLOWED_DOMAINS = [
  'usher.ttvnw.net',
  'gql.twitch.tv',
  '.ttvnw.net',
  '.cloudfront.net',
  '.hls.ttvnw.net',
];

function isAllowed(url) {
  try {
    const u = new URL(url);
    return ALLOWED_DOMAINS.some(d => d.startsWith('.')
      ? u.hostname.endsWith(d)
      : u.hostname === d);
  } catch {
    return false;
  }
}

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Client-Id, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, X-Demuxed, X-Demux-Error');
}

// ============================================================================
// MPEG-TS → ADTS/AAC demuxer
// ============================================================================
// MPEG-TS is 188-byte packets starting with sync byte 0x47.
// We parse PAT/PMT to find the audio PID, then reassemble PES packets and
// extract the AAC payload (already in ADTS form for Twitch VODs).

function demuxTStoADTS(tsBytes) {
  const PACKET_SIZE = 188;
  if (tsBytes.length < PACKET_SIZE || tsBytes[0] !== 0x47) {
    throw new Error('Not a valid MPEG-TS stream (missing sync byte)');
  }

  // First pass: find audio PID via PAT → PMT
  let audioPID = -1;
  let pmtPID = -1;

  for (let offset = 0; offset + PACKET_SIZE <= tsBytes.length; offset += PACKET_SIZE) {
    if (tsBytes[offset] !== 0x47) continue;
    const pid = ((tsBytes[offset + 1] & 0x1F) << 8) | tsBytes[offset + 2];
    const payloadStart = (tsBytes[offset + 1] & 0x40) !== 0;
    const adaptationField = (tsBytes[offset + 3] & 0x30) >> 4;
    let payloadOffset = offset + 4;
    if (adaptationField === 2 || adaptationField === 3) {
      const afLen = tsBytes[offset + 4];
      payloadOffset = offset + 5 + afLen;
    }

    if (pid === 0 && payloadStart) {
      const pointer = tsBytes[payloadOffset];
      const patStart = payloadOffset + 1 + pointer;
      const sectionLen = ((tsBytes[patStart + 1] & 0x0F) << 8) | tsBytes[patStart + 2];
      const programsStart = patStart + 8;
      const programsEnd = patStart + 3 + sectionLen - 4;
      for (let p = programsStart; p + 4 <= programsEnd; p += 4) {
        const prog = (tsBytes[p] << 8) | tsBytes[p + 1];
        const pmt = ((tsBytes[p + 2] & 0x1F) << 8) | tsBytes[p + 3];
        if (prog !== 0) { pmtPID = pmt; break; }
      }
    } else if (pid === pmtPID && payloadStart && pmtPID >= 0) {
      const pointer = tsBytes[payloadOffset];
      const pmtStart = payloadOffset + 1 + pointer;
      const sectionLen = ((tsBytes[pmtStart + 1] & 0x0F) << 8) | tsBytes[pmtStart + 2];
      const programInfoLen = ((tsBytes[pmtStart + 10] & 0x0F) << 8) | tsBytes[pmtStart + 11];
      let esStart = pmtStart + 12 + programInfoLen;
      const esEnd = pmtStart + 3 + sectionLen - 4;
      while (esStart + 5 <= esEnd) {
        const streamType = tsBytes[esStart];
        const esPid = ((tsBytes[esStart + 1] & 0x1F) << 8) | tsBytes[esStart + 2];
        const esInfoLen = ((tsBytes[esStart + 3] & 0x0F) << 8) | tsBytes[esStart + 4];
        // 0x0F = AAC ADTS, 0x11 = AAC LATM
        if (streamType === 0x0F || streamType === 0x11) {
          audioPID = esPid;
          break;
        }
        esStart += 5 + esInfoLen;
      }
      if (audioPID >= 0) break;
    }
  }

  if (audioPID < 0) audioPID = 0x101; // common Twitch default

  // Second pass: reassemble PES payloads for the audio PID
  const pesChunks = [];
  let currentPES = null;

  for (let offset = 0; offset + PACKET_SIZE <= tsBytes.length; offset += PACKET_SIZE) {
    if (tsBytes[offset] !== 0x47) continue;
    const pid = ((tsBytes[offset + 1] & 0x1F) << 8) | tsBytes[offset + 2];
    if (pid !== audioPID) continue;

    const payloadStart = (tsBytes[offset + 1] & 0x40) !== 0;
    const adaptationField = (tsBytes[offset + 3] & 0x30) >> 4;
    let payloadOffset = offset + 4;
    if (adaptationField === 2 || adaptationField === 3) {
      const afLen = tsBytes[offset + 4];
      payloadOffset = offset + 5 + afLen;
    }
    if (payloadOffset >= offset + PACKET_SIZE) continue;
    const payloadEnd = offset + PACKET_SIZE;

    if (payloadStart) {
      if (currentPES) pesChunks.push(currentPES);
      currentPES = Buffer.from(tsBytes.slice(payloadOffset, payloadEnd));
    } else if (currentPES) {
      currentPES = Buffer.concat([currentPES, Buffer.from(tsBytes.slice(payloadOffset, payloadEnd))]);
    }
  }
  if (currentPES) pesChunks.push(currentPES);

  // Extract AAC from each PES
  const adtsFrames = [];
  for (const pes of pesChunks) {
    if (pes.length < 9 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) continue;
    if (pes[3] < 0xC0 || pes[3] > 0xDF) continue;  // audio stream IDs
    const pesHeaderDataLen = pes[8];
    const aacStart = 9 + pesHeaderDataLen;
    if (aacStart >= pes.length) continue;
    adtsFrames.push(pes.slice(aacStart));
  }

  if (!adtsFrames.length) {
    throw new Error(`No AAC frames extracted (audioPID=${audioPID}, pesCount=${pesChunks.length})`);
  }
  return Buffer.concat(adtsFrames);
}

// ============================================================================
// HTTP server
// ============================================================================

async function fetchFromTwitch(target, reqHeaders, reqMethod, reqBody) {
  const fetchOptions = {
    method: reqMethod,
    headers: { 'User-Agent': 'VOD-Desk-Proxy/2.0' },
  };
  if (reqHeaders['client-id']) fetchOptions.headers['Client-Id'] = reqHeaders['client-id'];
  if (reqHeaders['authorization']) fetchOptions.headers['Authorization'] = reqHeaders['authorization'];
  if (reqHeaders['content-type']) fetchOptions.headers['Content-Type'] = reqHeaders['content-type'];
  if (reqMethod === 'POST' && reqBody) fetchOptions.body = reqBody;
  return fetch(target, fetchOptions);
}

const server = http.createServer(async (req, res) => {
  setCORSHeaders(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'vod-desk-proxy', version: 2, features: ['ts-demux'] }));
    return;
  }

  const isAudioMode = req.url.startsWith('/proxy-audio');
  const isPlainMode = !isAudioMode && req.url.startsWith('/proxy');

  if (isAudioMode || isPlainMode) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const target = urlObj.searchParams.get('url');

    if (!target) { res.writeHead(400); res.end('Missing ?url='); return; }
    if (!isAllowed(target)) {
      console.log(`[BLOCKED] ${target}`);
      res.writeHead(403); res.end('URL not allowed'); return;
    }

    try {
      const mode = isAudioMode ? 'AUDIO' : 'PLAIN';
      console.log(`[${mode}] ${target.slice(0, 110)}${target.length > 110 ? '...' : ''}`);

      let reqBody = null;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        reqBody = Buffer.concat(chunks);
      }

      const upstream = await fetchFromTwitch(target, req.headers, req.method, reqBody);

      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'Content-Type': 'text/plain' });
        res.end(`Upstream returned ${upstream.status}`);
        console.log(`[FAIL] ${upstream.status} ${target.slice(0, 80)}`);
        return;
      }

      if (isAudioMode) {
        const bytes = Buffer.from(await upstream.arrayBuffer());
        try {
          const adts = demuxTStoADTS(bytes);
          res.writeHead(200, {
            'Content-Type': 'audio/aac',
            'X-Demuxed': '1',
            'Access-Control-Expose-Headers': 'X-Demuxed, X-Demux-Error',
          });
          res.end(adts);
          console.log(`[OK]    demuxed ${bytes.length} → ${adts.length} bytes`);
        } catch (e) {
          console.log(`[WARN]  demux failed (${e.message}), passing through raw`);
          res.writeHead(200, {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'X-Demuxed': '0',
            'X-Demux-Error': e.message,
          });
          res.end(bytes);
        }
      } else {
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
        console.log(`[OK]    ${upstream.status} (passthrough)`);
      }
    } catch (err) {
      console.log(`[ERROR] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log('================================================');
  console.log('  VOD Desk — Local Audio Proxy  v2  (TS demux)');
  console.log('================================================');
  console.log(`  Running at:  http://${HOST}:${PORT}`);
  console.log(`  Health URL:  http://${HOST}:${PORT}/health`);
  console.log('');
  console.log('  In the VOD Desk app, paste this URL into');
  console.log('  the "Audio Proxy URL" field:');
  console.log('');
  console.log(`    http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Keep this window open. Ctrl+C to stop.');
  console.log('================================================');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error('Close any other proxy, or change PORT at the top of this file.\n');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
