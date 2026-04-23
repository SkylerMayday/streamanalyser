/**
 * audio-probe.js — Stream Analyser audio analysis module
 * =======================================================
 * Extracted from index.html for cleaner separation of concerns.
 *
 * Exports (attached to window.AudioProbe):
 *   detectAudioMoments(audioResults, decodedSegments) → moments[]
 *   computeLoudnessStats(decodedSegments) → stats | null
 *   getVideoAccessToken(vodId) → token
 *   getVODPlaylistURL(vodId) → url
 *   fetchText(url) → string
 *   fetchBytes(url) → Uint8Array
 *   getProxyUrl() → string | null
 *   parseMasterPlaylist(text) → variants[]
 *   parseMediaPlaylist(text, baseUrl) → segments[]
 *   transmuxTStoMP4(tsBytes) → Uint8Array
 *   decodeSegment(ctx, bytes) → AudioBuffer
 *   detectEcho(samples, sampleRate) → {echo, confidence, lagMs}
 *   analyzeAudio(vodId, duration) → result
 *   setupCaptionAudioSource(vodId) → source
 *   extractAudioWindow(source, startSec, durationSec) → Float32Array
 *   renderAudio(audio) → void  (writes to DOM)
 *   renderLoudnessPanel(L) → void  (writes to DOM)
 *
 * Depends on:
 *   window.gql         — shared GQL fetch helper (defined in index.html)
 *   window.setPill     — pill status updater
 *   window.setProgress — progress bar updater
 *   window.log         — debug log
 *   window.fmtDur      — time formatter
 *   window.escapeHTML  — HTML escaper
 *   muxjs              — loaded via CDN script tag in index.html
 */

(function (global) {
  'use strict';


// ===============================================
// Audio-triggered moment detection
// ===============================================
// Extract short-window RMS energy from decoded audio segments, find peaks 2+σ above baseline
function detectAudioMoments(audioResults, decodedSegments) {
  // decodedSegments: array of { offset, buffer (AudioBuffer) }
  if (!decodedSegments || !decodedSegments.length) return [];
  const moments = [];
  decodedSegments.forEach(({ offset, buffer }) => {
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const windowSec = 1.0;
    const windowSize = Math.floor(sr * windowSec);
    const hop = Math.floor(windowSize / 2);
    const energies = [];
    for (let i = 0; i + windowSize <= ch.length; i += hop) {
      let sum = 0;
      for (let j = 0; j < windowSize; j++) sum += ch[i + j] * ch[i + j];
      const rms = Math.sqrt(sum / windowSize);
      energies.push({ tOffset: i / sr, rms });
    }
    if (energies.length < 4) return;
    const mean = energies.reduce((a, b) => a + b.rms, 0) / energies.length;
    const sd = Math.sqrt(energies.reduce((a, b) => a + (b.rms - mean) ** 2, 0) / energies.length);
    if (sd < 1e-5) return;
    // Find peaks > 2σ above mean AND above absolute threshold
    energies.forEach(e => {
      const z = (e.rms - mean) / sd;
      if (z >= 2.0 && e.rms > 0.05) {
        moments.push({
          absoluteTime: offset + e.tOffset,
          rms: e.rms,
          zScore: z
        });
      }
    });
  });
  // Dedupe nearby moments (within 2s)
  moments.sort((a, b) => a.absoluteTime - b.absoluteTime);
  const deduped = [];
  moments.forEach(m => {
    if (!deduped.length || m.absoluteTime - deduped[deduped.length - 1].absoluteTime > 3) {
      deduped.push(m);
    } else if (m.zScore > deduped[deduped.length - 1].zScore) {
      deduped[deduped.length - 1] = m;
    }
  });
  return deduped;
}

// ===============================================
// Loudness & clipping analysis
// ===============================================
// Analyses the same decoded audio buffers the probe already fetched, so this
// costs zero extra network calls. Returns peak level (dBFS), average loudness,
// percentage of samples clipping, and percentage of the probe that was near-silent.
//
// Thresholds reflect streaming norms, not broadcast (ATSC/EBU R128) norms —
// Twitch streams aren't loudness-normalized, but viewer expectations cluster
// around -14 to -16 dBFS average for voice-forward content.
function computeLoudnessStats(decodedSegments) {
  if (!decodedSegments || !decodedSegments.length) return null;

  // Digital clip threshold — anything closer to full-scale than this is a clip.
  // 0.99 rather than 1.0 because post-encode near-unity samples usually mean
  // the signal *was* clipped pre-encoding even if not mathematically at 1.0.
  const CLIP_THRESHOLD = 0.99;
  // Near-silence threshold: RMS below -50 dBFS in a 1s window counts as quiet.
  const SILENCE_RMS = Math.pow(10, -50 / 20);

  let totalSamples = 0;
  let clippedSamples = 0;
  let peak = 0;
  let sumSquares = 0; // for overall RMS
  let quietWindows = 0;
  let totalWindows = 0;

  decodedSegments.forEach(({ buffer }) => {
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const winSize = Math.floor(sr * 1.0); // 1-second windows for the silence metric

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      if (abs >= CLIP_THRESHOLD) clippedSamples++;
      sumSquares += s * s;
      totalSamples++;
    }

    // Windowed silence detection: count how many 1-second windows were quiet
    for (let i = 0; i + winSize <= ch.length; i += winSize) {
      let wSum = 0;
      for (let j = 0; j < winSize; j++) wSum += ch[i + j] * ch[i + j];
      const wRms = Math.sqrt(wSum / winSize);
      if (wRms < SILENCE_RMS) quietWindows++;
      totalWindows++;
    }
  });

  if (!totalSamples) return null;

  const meanRms = Math.sqrt(sumSquares / totalSamples);
  // Convert to dBFS. Floor at -100 to avoid -Infinity for true silence.
  const peakDbFS = peak > 0 ? 20 * Math.log10(peak) : -100;
  const meanDbFS = meanRms > 0 ? 20 * Math.log10(meanRms) : -100;
  const clippingPct = (clippedSamples / totalSamples) * 100;
  const quietPct = totalWindows ? (quietWindows / totalWindows) * 100 : 0;

  return { peakDbFS, meanDbFS, clippingPct, quietPct, samplesAnalysed: totalSamples };
}

// ===============================================
// Clip scoring
// ===============================================
const HYPE_KEYWORDS = /\b(pog|poggers|lol|lmao|lmfao|rofl|omg|wtf|holy|insane|clutch|nice|gg|wp|hype|W|cracked|clean|nuts|no way|let'?s go|lets go|goated|goat|sick|sheesh|based|actual|literally|bro|wait what)\b/i;
const LAUGH_EMOJIS = /[😂🤣😭💀]|KEKW|LULW|OMEGALUL|PepeLaugh|LUL|KEK/g;
const HYPE_EMOTES = /PogChamp|Pog|POGGERS|WAYTOODANK|PepegaCredit|EZ|EZY|W\s*$|Clap|PogU/g;

function scoreClips(comments, duration, audioMoments) {
  if (!comments.length) return [];
  const windowSec = 30;
  const hopSec = 10;
  const windows = [];
  // Pre-sort
  comments.sort((a,b) => a.t - b.t);

  // Build velocity envelope
  const binSec = 5;
  const nBins = Math.ceil(duration / binSec);
  const bins = new Array(nBins).fill(0);
  comments.forEach(c => {
    const i = Math.floor(c.t / binSec);
    if (i >= 0 && i < nBins) bins[i]++;
  });
  const mean = bins.reduce((a,b) => a+b, 0) / bins.length || 1;
  const sd = Math.sqrt(bins.reduce((a,b) => a + (b-mean)**2, 0) / bins.length) || 1;

  // Rolling windows
  for (let start = 0; start + windowSec <= duration; start += hopSec) {
    const end = start + windowSec;
    const winMsgs = comments.filter(c => c.t >= start && c.t < end);
    if (!winMsgs.length) continue;

    // Velocity (z-score)
    const startBin = Math.floor(start / binSec);
    const endBin = Math.floor(end / binSec);
    const winBinSum = bins.slice(startBin, endBin).reduce((a,b) => a+b, 0);
    const binsInWin = Math.max(1, endBin - startBin);
    const z = ((winBinSum / binsInWin) - mean) / sd;

    // Excitement
    let laughs = 0, hype = 0, hypeEmotes = 0;
    winMsgs.forEach(m => {
      const msg = m.msg || '';
      const laughMatches = msg.match(LAUGH_EMOJIS);
      if (laughMatches) laughs += laughMatches.length;
      if (HYPE_KEYWORDS.test(msg)) hype++;
      const emoteMatches = msg.match(HYPE_EMOTES);
      if (emoteMatches) hypeEmotes += emoteMatches.length;
    });

    // Unique commenters (broad reaction > same user spamming)
    const uniqueUsers = new Set(winMsgs.map(m => m.user)).size;

    // Audio moments overlapping this window
    const windowAudioMoments = (audioMoments || []).filter(
      m => m.absoluteTime >= start && m.absoluteTime < end
    );
    const audioBoost = windowAudioMoments.length > 0
      ? Math.min(3.0, windowAudioMoments.reduce((sum, m) => sum + m.zScore, 0) * 0.4)
      : 0;

    // Composite score (blended: chat spike + excitement + audio)
    const velocityScore = Math.max(0, z) * 1.0;
    const excitementScore = (laughs * 0.35 + hype * 0.45 + hypeEmotes * 0.4 + uniqueUsers * 0.15) / windowSec;
    const score = velocityScore + excitementScore * 2.5 + audioBoost;

    windows.push({
      start, end,
      score,
      z,
      laughs, hype, hypeEmotes,
      unique: uniqueUsers,
      msgCount: winMsgs.length,
      sample: winMsgs.slice(0, 12),
      audioMoments: windowAudioMoments,
      audioBoost
    });
  }

  // Non-max suppression: don't return overlapping windows
  windows.sort((a,b) => b.score - a.score);
  const picked = [];
  for (const w of windows) {
    if (picked.some(p => !(w.end < p.start - 20 || w.start > p.end + 20))) continue;
    picked.push(w);
    if (picked.length >= 12) break;
  }
  picked.sort((a,b) => b.score - a.score);
  return picked;
}

// Reasoning text
function clipReason(c) {
  const parts = [];
  if (c.audioBoost > 0.5) parts.push(`<strong>audio spike</strong> (${c.audioMoments.length} peak${c.audioMoments.length>1?'s':''})`);
  if (c.z > 2) parts.push(`chat velocity spiked <strong>${c.z.toFixed(1)}σ</strong> above baseline`);
  else if (c.z > 1) parts.push(`chat activity up <strong>${c.z.toFixed(1)}σ</strong>`);
  if (c.laughs > 5) parts.push(`${c.laughs} laugh reactions`);
  if (c.hypeEmotes > 3) parts.push(`${c.hypeEmotes} hype emotes (PogU / EZ / Clap)`);
  if (c.hype > 5) parts.push(`${c.hype} hype keywords (W / insane / clutch)`);
  if (c.unique > 15) parts.push(`<strong>${c.unique}</strong> unique commenters reacting`);
  if (!parts.length) parts.push(`${c.msgCount} messages in window`);
  return parts.join(' · ');
}

// ===============================================
// Audio echo detection via HLS fetch + autocorrelation
// ===============================================
async function getVideoAccessToken(vodId) {
  const body = [{
    operationName: 'PlaybackAccessToken',
    variables: { isLive: false, login: '', isVod: true, vodID: vodId, playerType: 'embed' },
    extensions: { persistedQuery: { version: 1, sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712' }}
  }];
  const j = await gql(body);
  const tok = j[0]?.data?.videoPlaybackAccessToken;
  if (!tok) throw new Error('Could not get playback token');
  return tok;
}
async function getVODPlaylistURL(vodId) {
  const tok = await getVideoAccessToken(vodId);
  const url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&sig=${encodeURIComponent(tok.signature)}&token=${encodeURIComponent(tok.value)}`;
  return url;
}
async function fetchText(url) {
  const proxyUrl = getProxyUrl();
  const fetchUrl = proxyUrl
    ? `${proxyUrl}/proxy?url=${encodeURIComponent(url)}`
    : url;
  const r = await fetch(fetchUrl, { mode: 'cors' });
  if (!r.ok) throw new Error('fetch failed ' + r.status);
  return r.text();
}
async function fetchBytes(url) {
  const proxyUrl = getProxyUrl();
  const fetchUrl = proxyUrl
    ? `${proxyUrl}/proxy?url=${encodeURIComponent(url)}`
    : url;
  const r = await fetch(fetchUrl, { mode: 'cors' });
  if (!r.ok) throw new Error('fetch failed ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// Get the configured proxy URL from localStorage, or null if not set
function getProxyUrl() {
  try {
    const saved = JSON.parse(localStorage.getItem('vodDeskCreds') || '{}');
    return saved.proxyUrl ? saved.proxyUrl.replace(/\/$/, '') : null;
  } catch { return null; }
}

function parseMasterPlaylist(text) {
  const lines = text.split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const info = lines[i];
      const uri = lines[i+1];
      const bw = (info.match(/BANDWIDTH=(\d+)/) || [])[1];
      variants.push({ uri, bandwidth: +(bw||0) });
    }
  }
  return variants;
}
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split('\n');
  const segs = [];
  let dur = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('#EXTINF:')) {
      dur = parseFloat(l.slice(8).split(',')[0]);
    } else if (l && !l.startsWith('#')) {
      segs.push({ uri: new URL(l, baseUrl).href, duration: dur });
      dur = 0;
    }
  }
  return segs;
}

// Transmux TS bytes to fMP4 using mux.js, then decode to AudioBuffer.
// Twitch serves VOD audio as MPEG-TS which most browsers no longer decode directly.
// mux.js repackages into fMP4 (fragmented MP4) which every browser decodes reliably.
function transmuxTStoMP4(tsBytes) {
  return new Promise((resolve, reject) => {
    if (typeof muxjs === 'undefined') {
      reject(new Error('mux.js not loaded — check your internet connection'));
      return;
    }
    try {
      const transmuxer = new muxjs.mp4.Transmuxer({
        remux: true,        // output a single fMP4
        keepOriginalTimestamps: true
      });
      const chunks = [];
      let initSegment = null;
      transmuxer.on('data', (seg) => {
        if (seg.type === 'combined' || seg.type === 'audio') {
          // seg.initSegment is the moov (metadata), seg.data is the mdat (payload)
          if (!initSegment && seg.initSegment) initSegment = seg.initSegment;
          chunks.push(seg.data);
        }
      });
      transmuxer.on('done', () => {
        if (!initSegment || !chunks.length) {
          reject(new Error('transmux produced no audio output'));
          return;
        }
        // Concatenate init + all media chunks into one fMP4 file
        const totalLen = initSegment.byteLength + chunks.reduce((a, c) => a + c.byteLength, 0);
        const out = new Uint8Array(totalLen);
        out.set(initSegment, 0);
        let off = initSegment.byteLength;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        resolve(out);
      });
      transmuxer.push(tsBytes);
      transmuxer.flush();
    } catch (e) {
      reject(new Error('transmux: ' + e.message));
    }
  });
}

// Decode audio from a TS segment: transmux → fMP4 → AudioBuffer
async function decodeSegment(ctx, bytes) {
  let decodeInput;
  try {
    const fmp4 = await transmuxTStoMP4(bytes);
    decodeInput = fmp4.buffer.slice(fmp4.byteOffset, fmp4.byteOffset + fmp4.byteLength);
  } catch (transmuxErr) {
    // Transmux failed — fall back to trying raw bytes (some segments may already be fMP4)
    decodeInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  try {
    return await ctx.decodeAudioData(decodeInput);
  } catch (e) {
    throw new Error('decode: ' + e.message);
  }
}

// Autocorrelation for echo detection
function detectEcho(samples, sampleRate) {
  // Downsample to mono ~8kHz for speed
  const target = 8000;
  const ratio = sampleRate / target;
  const N = Math.floor(samples.length / ratio);
  const mono = new Float32Array(N);
  for (let i = 0; i < N; i++) mono[i] = samples[Math.floor(i * ratio)] || 0;

  // Energy normalize
  let mean = 0;
  for (let i = 0; i < N; i++) mean += mono[i];
  mean /= N;
  for (let i = 0; i < N; i++) mono[i] -= mean;

  // Check autocorrelation at lags 50–400ms
  const minLag = Math.floor(0.05 * target);
  const maxLag = Math.floor(0.4 * target);
  let r0 = 0;
  for (let i = 0; i < N; i++) r0 += mono[i]*mono[i];
  if (r0 < 1e-6) return { echo: false, confidence: 0, lagMs: 0 };

  let bestLag = 0, bestR = 0;
  // Downsample lag space for speed
  for (let lag = minLag; lag <= maxLag; lag += 4) {
    let r = 0;
    const cap = N - lag;
    // Sub-sample dot product for speed
    for (let i = 0; i < cap; i += 2) r += mono[i] * mono[i + lag];
    r /= r0;
    if (r > bestR) { bestR = r; bestLag = lag; }
  }

  const lagMs = (bestLag / target) * 1000;
  const echo = bestR > 0.35 && lagMs >= 50 && lagMs <= 400;
  return { echo, confidence: bestR, lagMs };
}

async function analyzeAudio(vodId, duration) {
  setPill('pill-audio', 'Audio probe · starting', 'busy');
  log('Requesting VOD playback token…');
  let masterUrl;
  try { masterUrl = await getVODPlaylistURL(vodId); }
  catch (e) { setPill('pill-audio', 'Audio probe · no access', 'warn'); throw e; }

  log('Fetching HLS master playlist…');
  let master;
  try { master = await fetchText(masterUrl); }
  catch (e) {
    setPill('pill-audio', 'Audio probe · CORS blocked', 'warn');
    return { blocked: true, reason: 'Twitch CDN blocked audio fetch (CORS). Browsers can\'t pull VOD audio without a proxy.' };
  }

  const variants = parseMasterPlaylist(master);
  if (!variants.length) { setPill('pill-audio', 'Audio probe · no variants', 'err'); return { blocked: true, reason: 'No playable variants found.' }; }
  // Pick the lowest-bandwidth variant (fastest to fetch)
  variants.sort((a,b) => a.bandwidth - b.bandwidth);
  const variant = variants[0];
  log(`Chose variant at ${Math.round(variant.bandwidth/1000)} kbps`);

  let mediaPlaylist;
  try { mediaPlaylist = await fetchText(variant.uri); }
  catch (e) { return { blocked: true, reason: 'Media playlist fetch blocked.' }; }
  const segs = parseMediaPlaylist(mediaPlaylist, variant.uri);
  if (!segs.length) return { blocked: true, reason: 'No segments in playlist.' };

  // Sample 15 segments evenly
  const sampleCount = Math.min(15, segs.length);
  const stride = Math.max(1, Math.floor(segs.length / sampleCount));
  const sampled = [];
  for (let i = 0; i < segs.length && sampled.length < sampleCount; i += stride) sampled.push({ seg: segs[i], idx: i });

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const results = [];
  const decodedBuffers = [];
  let decoded = 0, decodeFails = 0;

  for (let si = 0; si < sampled.length; si++) {
    const { seg, idx } = sampled[si];
    setPill('pill-audio', `Audio probe · ${si+1}/${sampled.length}`, 'busy');
    setProgress(60 + (si / sampled.length) * 30);
    try {
      const bytes = await fetchBytes(seg.uri);
      const buf = await decodeSegment(ctx, bytes);
      decoded++;
      // Compute offset in VOD
      const offset = segs.slice(0, idx).reduce((a,s) => a + s.duration, 0);
      // Mixdown to mono
      const ch = buf.getChannelData(0);
      const r = detectEcho(ch, buf.sampleRate);
      results.push({ offset, ...r });
      decodedBuffers.push({ offset, buffer: buf });
    } catch (e) {
      decodeFails++;
    }
  }
  // Note: ctx left open; closed by caller after moment detection

  if (decoded === 0) {
    ctx.close();
    return { blocked: true, reason: 'All audio segments failed to decode after transmuxing. Check browser console for details — this could be a mux.js loading failure (check internet / ad blockers) or an unexpected segment format.' };
  }

  return { blocked: false, results, decoded, decodeFails, decodedBuffers, audioContext: ctx };
}

async function setupCaptionAudioSource(vodId) {
  if (window.__captionAudioSource && window.__captionAudioSource.vodId === vodId) return window.__captionAudioSource;
  try {
    const masterUrl = await getVODPlaylistURL(vodId);
    const master = await fetchText(masterUrl);
    const variants = parseMasterPlaylist(master);
    if (!variants.length) throw new Error('No variants');
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    const variant = variants[0];
    const mediaPlaylist = await fetchText(variant.uri);
    const segs = parseMediaPlaylist(mediaPlaylist, variant.uri);
    if (!segs.length) throw new Error('No segments');
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    window.__captionAudioSource = {
      vodId,
      playlistSegs: segs,
      audioContext: ctx,
      cachedSegments: new Map()
    };
    return window.__captionAudioSource;
  } catch (e) {
    throw new Error('Could not access VOD audio: ' + e.message);
  }
}

// Fetch + decode segments spanning [startSec, startSec+durationSec], return a single Float32Array @ 16kHz mono
async function extractAudioWindow(source, startSec, durationSec) {
  const endSec = startSec + durationSec;
  // Find which segments cover this range
  let cursor = 0;
  const wanted = [];
  for (let i = 0; i < source.playlistSegs.length; i++) {
    const segStart = cursor;
    const segEnd = cursor + source.playlistSegs[i].duration;
    if (segEnd > startSec && segStart < endSec) {
      wanted.push({ idx: i, segStart, segEnd });
    }
    cursor = segEnd;
    if (segStart > endSec) break;
  }
  if (!wanted.length) throw new Error('No segments cover this timestamp');
  // Fetch and decode each (with cache)
  const decoded = [];
  for (const w of wanted) {
    if (source.cachedSegments.has(w.idx)) {
      decoded.push({ ...w, buffer: source.cachedSegments.get(w.idx) });
      continue;
    }
    const bytes = await fetchBytes(source.playlistSegs[w.idx].uri);
    // Use the shared transmux-first decoder so TS segments work in all browsers
    const buffer = await decodeSegment(source.audioContext, bytes);
    source.cachedSegments.set(w.idx, buffer);
    decoded.push({ ...w, buffer });
    // Memory cap: keep only last 6 cached
    if (source.cachedSegments.size > 6) {
      const firstKey = source.cachedSegments.keys().next().value;
      source.cachedSegments.delete(firstKey);
    }
  }
  // Concatenate the portions of each buffer that fall within [startSec, endSec]
  const TARGET_SR = 16000;
  const outLen = Math.floor(durationSec * TARGET_SR);
  const out = new Float32Array(outLen);
  let writePos = 0;
  for (const { segStart, buffer } of decoded) {
    const bufStart = Math.max(0, startSec - segStart);
    const bufEnd = Math.min(buffer.duration, endSec - segStart);
    if (bufEnd <= bufStart) continue;
    const sr = buffer.sampleRate;
    const startSample = Math.floor(bufStart * sr);
    const endSample = Math.floor(bufEnd * sr);
    const ch = buffer.getChannelData(0);
    // Resample to 16kHz by linear interpolation
    const inputSpan = endSample - startSample;
    const outputSpan = Math.floor((bufEnd - bufStart) * TARGET_SR);
    for (let i = 0; i < outputSpan && writePos < outLen; i++) {
      const srcIdx = startSample + Math.floor(i * inputSpan / outputSpan);
      out[writePos++] = ch[srcIdx] || 0;
    }
  }
  return out;
}

// Render audio echo results
// ===============================================
function renderAudio(audio) {
  const el = $('#audio-results');
  if (!audio) { el.innerHTML = '<div class="empty-state">Audio probe skipped.</div>'; return; }
  if (audio.blocked) {
    el.innerHTML = `
      <div class="instructions-card" style="border-left-color: var(--warning); background: #fef9e6;">
        <h3>Audio analysis couldn't run</h3>
        <p style="font-family: var(--serif); font-size: 14px; line-height: 1.6; margin-top: 6px;">${escapeHTML(audio.reason)}</p>
        <p style="font-family: var(--serif); font-size: 14px; line-height: 1.6; margin-top: 10px;">You can still check for echo by uploading a local recording of your stream below — OBS's "Start Recording" output works perfectly, or a downloaded Twitch VOD via third-party tools. The same autocorrelation analysis runs on the uploaded file.</p>
        <button class="ghost small" id="upload-audio-btn-injected" style="margin-top: 12px;">Upload Recording</button>
      </div>
    `;
    // Note: use a distinct ID from the persistent Advanced-tab button, otherwise
    // querySelector returns the first match and this listener silently binds to
    // the wrong element (which is what broke the injected button previously).
    $('#upload-audio-btn-injected').addEventListener('click', () => $('#audio-upload').click());
    return;
  }
  const r = audio.results;
  const echoes = r.filter(x => x.echo);
  const avgConfidence = r.reduce((a,b) => a + b.confidence, 0) / r.length;
  const summaryClass = echoes.length >= 3 ? 'bad' : echoes.length > 0 ? 'warn' : 'good';
  const summaryLabel = echoes.length >= 3 ? 'FAIL' : echoes.length > 0 ? 'CHECK' : 'PASS';
  const summaryText = echoes.length >= 3
    ? `<strong>Echo detected</strong> in ${echoes.length} of ${r.length} probed segments. This is a strong signal of audio routing issues — most often the mic capturing speaker output (use headphones), duplicate desktop audio sources, or a monitor output routed back into the stream. Average self-correlation: ${avgConfidence.toFixed(2)}.`
    : echoes.length > 0
    ? `Possible echo in <strong>${echoes.length} of ${r.length}</strong> samples. Could be genuine echo, in-game audio with reverb, or music. Jump to the timestamps below to verify by ear.`
    : `Clean across all <strong>${r.length}</strong> sampled segments. No audio doubling detected.`;

  el.innerHTML = `
    <ul class="feedback-list" style="margin-bottom: 20px;">
      <li class="feedback-item">
        <span class="feedback-tag ${summaryClass}">${summaryLabel}</span>
        <div class="feedback-body">${summaryText}</div>
      </li>
    </ul>
    ${audio.loudness ? renderLoudnessPanel(audio.loudness) : ''}
    <div class="chart-wrap">
      <div class="chart-title"><span>Probe Results</span><span>${r.length} samples · lag 50–400ms</span></div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px;">
        ${r.map(x => `
          <div style="padding: 8px 10px; background: var(--paper); border: 1px solid var(--rule); ${x.echo ? 'border-left: 3px solid var(--danger);' : ''}">
            <div style="font-family: var(--mono); font-size: 11px; color: var(--ink); font-weight: 600;">${fmtDur(x.offset)}</div>
            <div style="font-family: var(--mono); font-size: 10px; color: ${x.echo ? 'var(--danger)' : 'var(--ink-dim)'}; margin-top: 3px;">
              ${x.echo ? 'ECHO' : 'clean'} · ${x.lagMs.toFixed(0)}ms · ${x.confidence.toFixed(2)}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Render the loudness stats grid shown on the Advanced Analysis card.
// Kept separate from renderAudio so the formatting is easy to adjust.
function renderLoudnessPanel(L) {
  // Colour each stat by how good/bad the value is, so at a glance the streamer
  // sees where to focus.
  const peakClass = L.clippingPct > 0.5 ? 'err' : L.peakDbFS > -1 ? 'warn' : 'ok';
  const meanClass = (L.meanDbFS >= -18 && L.meanDbFS < -12) ? 'ok'
                  : (L.meanDbFS < -28 || L.meanDbFS > -10) ? 'warn' : '';
  const clipClass = L.clippingPct > 0.5 ? 'err' : L.clippingPct > 0.05 ? 'warn' : 'ok';
  const quietClass = L.quietPct > 20 ? 'warn' : 'ok';

  const col = cls => cls === 'ok' ? 'var(--success)'
                   : cls === 'warn' ? 'var(--warning)'
                   : cls === 'err' ? 'var(--danger)'
                   : 'var(--ink)';

  return `
    <div class="stats-grid" style="margin-bottom: 20px;">
      <div class="stat">
        <div class="stat-label">Peak level</div>
        <div class="stat-value" style="color: ${col(peakClass)};">${L.peakDbFS.toFixed(1)}<span style="font-size: 13px; color: var(--ink-dim); margin-left: 2px;">dBFS</span></div>
        <div class="stat-sub">target &lt; -3 dBFS</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg loudness</div>
        <div class="stat-value" style="color: ${col(meanClass)};">${L.meanDbFS.toFixed(1)}<span style="font-size: 13px; color: var(--ink-dim); margin-left: 2px;">dBFS</span></div>
        <div class="stat-sub">target -14 to -16</div>
      </div>
      <div class="stat">
        <div class="stat-label">Clipping</div>
        <div class="stat-value" style="color: ${col(clipClass)};">${L.clippingPct.toFixed(2)}<span style="font-size: 13px; color: var(--ink-dim); margin-left: 2px;">%</span></div>
        <div class="stat-sub">samples at full-scale</div>
      </div>
      <div class="stat">
        <div class="stat-label">Near-silent</div>
        <div class="stat-value" style="color: ${col(quietClass)};">${L.quietPct.toFixed(0)}<span style="font-size: 13px; color: var(--ink-dim); margin-left: 2px;">%</span></div>
        <div class="stat-sub">1s windows &lt; -50 dBFS</div>
      </div>
    </div>
  `;
}

  // Attach all public functions to window.AudioProbe
  global.AudioProbe = {
    detectAudioMoments,
    computeLoudnessStats,
    getVideoAccessToken,
    getVODPlaylistURL,
    fetchText,
    fetchBytes,
    getProxyUrl,
    parseMasterPlaylist,
    parseMediaPlaylist,
    transmuxTStoMP4,
    decodeSegment,
    detectEcho,
    analyzeAudio,
    setupCaptionAudioSource,
    extractAudioWindow,
    renderAudio,
    renderLoudnessPanel,
  };

})(window);
