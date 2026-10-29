// The engine runs in the extension's offscreen document for the length of a call.
//
//   Meet tab audio  -> Scribe (their language) -> Claude -> ElevenLabs -> my speakers
//   my microphone   -> Scribe (my language)    -> Claude -> ElevenLabs -> Meet tab -> the call
//
// With free translation chosen, the free services in free-translator.js take Claude's place.
//
// Offscreen documents only get chrome.runtime, so settings arrive from the service
// worker with each message, and everything for the Meet tab goes through a port the
// tab's content script opens.

import { isFreeTranslation, missingKeys, parseKeyterms } from '../shared/settings.js';
import { listVoices, createVoiceClone, deleteVoice, describeElevenLabsError } from '../shared/elevenlabs.js';
import { PcmScheduler, testChime } from '../shared/scheduler.js';
import { int16ToBase64 } from '../shared/pcm.js';
import { EchoGuard, EarlySentences, isOnlyPunctuation } from '../shared/text.js';
import { Usage } from '../shared/usage.js';
import { ScribeRealtime } from './stt.js';
import { Translator, describeClaudeError } from './translator.js';
import { FreeTranslator, freeKeys } from './free-translator.js';
import { synthesize } from './tts.js';
import { DirectionPipeline, History, Speaker } from './pipeline.js';
import { CloneCollector } from './voice-clone.js';
import { saveChunk, saveRecording, recordingChunks } from '../shared/recordings.js';
import { DebugSink, debugSinkUrl } from './debug-sink.js';

// The debug copy is compiled in only by `npm run build:debug`; a normal build ignores
// the page's request for it.
const DEBUG_BUILD = typeof __DEBUG_SINK__ !== 'undefined' && __DEBUG_SINK__;
import { setLanguage, t, joinNames, locale } from '../shared/i18n.js';

class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function log(level, ...args) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn('[tercuman]', ...args);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function findDevice(kind, label) {
  if (!label) return null;
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find((d) => d.kind === kind && d.label === label)?.deviceId || null;
}

function describeSttFatal(err, cause) {
  if (cause) return describeElevenLabsError(cause);
  switch (err.type) {
    case 'auth_error':
      return t('stt.auth');
    case 'quota_exceeded':
      return t('stt.quota');
    case 'unaccepted_terms':
      return t('stt.terms');
    default:
      return t('stt.stopped', { message: err.message });
  }
}

const MUTE_IDLE_MS = 20000;

let session = null;

// Read-only handle for DevTools and the live Meet test, which records what the user
// hears. Web pages cannot reach the offscreen document.
Object.defineProperty(globalThis, '__tercuman', { value: Object.freeze({ get session() { return session; } }) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err), code: err?.code }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'meet-tab') return;
  if (!session || port.sender?.tab?.id !== session.tabId) {
    port.disconnect();
    return;
  }
  session.attachTab(port);
});

async function handle(msg) {
  switch (msg.type) {
    case 'start': {
      if (session) {
        const old = session;
        session = null;
        await old.stop();
      }
      const next = new Session(msg);
      session = next;
      try {
        await next.start();
      } catch (err) {
        await next.stop();
        if (session === next) session = null;
        throw err;
      }
      return { ok: true, status: next.status() };
    }
    case 'stop': {
      const current = session;
      session = null;
      if (current) await current.stop();
      return { ok: true };
    }
    case 'options':
      session?.setOptions(msg.options || {});
      return { ok: true, status: session?.status() ?? null };
    case 'settings':
      session?.updateSettings(msg.settings);
      return { ok: true };
    case 'chime':
      session?.sendChime();
      return { ok: true };
    case 'status':
      return { ok: true, status: session?.status() ?? null };
    default:
      return { ok: false, error: `unknown message ${msg.type}` };
  }
}

class Session {
  constructor({ tabId, streamId, settings, options = {} }) {
    setLanguage(settings.uiLanguage);
    this.tabId = tabId;
    this.streamId = streamId;
    this.settings = settings;
    this.diagnostic = options.mode === 'diagnostic';
    this.incomingMode = this.diagnostic ? 'off' : options.incomingMode || settings.incomingMode;
    this.outgoingMode = this.diagnostic ? 'off' : options.outgoingMode || settings.outgoingMode;
    this.cloneConsent = Boolean(options.cloneConsent);
    this.recordRequested = Boolean(options.record);
    this.tabPort = null;
    this.page = { muted: true, senders: 0, micLabel: '', ctxState: 'unknown', backlog: 0, playing: false };
    this.levels = { tab: 0, mic: 0 };
    this.stt = { in: 'off', out: 'off' };
    this.usage = new Usage();
    this.latencies = [];
    this.warnings = new Map();
    this.clone = { state: 'off' };
    this.error = null;
    this.stopped = false;
  }

  async start() {
    const s = this.settings;
    if (!this.diagnostic) {
      const missing = missingKeys(s);
      if (missing.length) throw new UserError(t('err.keysMissing', { names: joinNames(missing) }), 'keys');
    }

    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    await this.ctx.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'));
    await this.applyOutputDevice();
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(this.ctx.destination);

    // A captured tab goes quiet for the user, so its audio is routed back to the
    // speakers here, at a level that dips while a translation is speaking.
    this.tabStream = await this.captureTab();
    const tabSource = this.ctx.createMediaStreamSource(this.tabStream);
    this.tabSource = tabSource;
    this.originalGain = this.ctx.createGain();
    this.originalGain.gain.value = this.originalLevel(false);
    tabSource.connect(this.originalGain).connect(this.ctx.destination);
    this.tabNode = this.captureNode((m) => this.onTabChunk(m));
    tabSource.connect(this.tabNode);
    this.tabStream.getAudioTracks()[0]?.addEventListener('ended', () => {
      this.fail(new UserError(t('err.tabEnded'), 'tab-ended'));
    });

    this.translationGain = this.ctx.createGain();
    this.translationGain.gain.value = s.translationVolume;
    this.translationGain.connect(this.ctx.destination);
    this.localPlayer = new PcmScheduler(this.ctx, this.translationGain, { onPlayingChange: () => this.updateDucking() });
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = s.monitorVolume;
    this.monitorGain.connect(this.ctx.destination);
    this.monitorPlayer = new PcmScheduler(this.ctx, this.monitorGain);

    await this.openMic();
    if (!this.diagnostic) await this.startTranslation();
    if (this.recordRequested) this.startRecording();

    this.statusTimer = setInterval(() => this.report(), 1000);
    this.report();
  }

  captureNode(onMessage) {
    const node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: 16000, chunkMs: 100 },
    });
    node.port.onmessage = (event) => onMessage(event.data);
    node.connect(this.silentSink);
    return node;
  }

  async captureTab() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId } },
        // A tab can be captured only once, so the picture for a recording comes now or never.
        video: this.recordRequested
          ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } }
          : false,
      });
    } catch (err) {
      throw new UserError(t('err.tabCapture', { name: err.name || err.message }), 'tab-capture');
    }
  }

  async openMic(preferredLabel) {
    const label = this.settings.micDeviceLabel || preferredLabel || this.page.micLabel;
    const deviceId = await findDevice('audioinput', label);
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        throw new UserError(t('err.micPermission'), 'mic-permission');
      }
      if (!deviceId) throw new UserError(t('err.mic', { name: err.name }), 'mic');
      delete audio.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = stream;
    this.micLabel = stream.getAudioTracks()[0]?.label || '';
    this.micSource = this.ctx.createMediaStreamSource(stream);
    if (!this.micNode) this.micNode = this.captureNode((m) => this.onMicChunk(m));
    this.micSource.connect(this.micNode);
    if (this.recordMicGain) this.micSource.connect(this.recordMicGain);
  }

  // When Meet uses a different microphone than ours, switch to the same one.
  async followMeetMic(label) {
    if (this.switchingMic || this.settings.micDeviceLabel || label === this.micLabel) return;
    this.switchingMic = true;
    try {
      if (await findDevice('audioinput', label)) await this.openMic(label);
    } catch (err) {
      log('warn', 'could not follow the Meet microphone', err);
    } finally {
      this.switchingMic = false;
    }
  }

  async applyOutputDevice() {
    const label = this.settings.outputDeviceLabel;
    if (!label || typeof this.ctx.setSinkId !== 'function') return;
    const id = await findDevice('audiooutput', label);
    if (id) await this.ctx.setSinkId(id).catch((err) => log('warn', 'setSinkId', err));
  }

  async startTranslation() {
    const s = this.settings;
    const keyterms = parseKeyterms(s.keyterms);
    this.translator = this.createTranslator(s);

    // Check the keys before the call depends on them, so a bad key shows up now.
    await Promise.all([this.verifyTranslator(), this.resolveVoices()]);

    this.history = new History(12);
    this.early = { in: new EarlySentences(), out: new EarlySentences() };
    this.sentGuard = new EchoGuard(); // my translated voice, in their language
    this.playedGuard = new EchoGuard(); // their translated voice, in my language

    this.incoming = new DirectionPipeline({
      dir: 'in',
      from: s.theirLanguage,
      to: s.myLanguage,
      translator: this.translator,
      history: this.history,
      echoGuard: this.sentGuard,
      speaker: new Speaker({
        synth: (item) => this.speak(item, 'in'),
        sink: this.localSink(),
        onFirstAudio: (item) => this.onFirstAudio(item),
        onSpoken: (item, when) => this.playedGuard.remember(item.text, when),
        onError: (item, err) => this.onSpeechError('in', item, err),
      }),
      emit: (e) => this.caption('in', e),
      describeError: describeClaudeError,
      isConcise: () => this.localPlayer.backlog() + this.incoming.speaker.pendingSeconds() > 8,
    });
    this.outgoing = new DirectionPipeline({
      dir: 'out',
      from: s.myLanguage,
      to: s.theirLanguage,
      translator: this.translator,
      history: this.history,
      echoGuard: this.playedGuard,
      speaker: new Speaker({
        synth: (item) => this.speak(item, 'out'),
        sink: this.remoteSink(),
        onFirstAudio: (item) => this.onFirstAudio(item),
        onSpoken: (item, when) => this.sentGuard.remember(item.text, when),
        onError: (item, err) => this.onSpeechError('out', item, err),
      }),
      emit: (e) => this.caption('out', e),
      describeError: describeClaudeError,
      isConcise: () => this.page.backlog + this.outgoing.speaker.pendingSeconds() > 8,
    });
    this.incoming.setMode(this.incomingMode);
    this.outgoing.setMode(this.outgoingMode === 'voice' ? 'voice' : 'off');

    this.sttIn = this.createStt('in', s.theirLanguage, keyterms);
    this.sttOut = this.createStt('out', s.myLanguage, keyterms);
    this.ensureStt('in', this.incomingMode !== 'off');
    // My side starts listening once Meet is actually sending my microphone (see onOutgoingOpened).
    this.ensureStt('out', this.outgoingMode === 'voice' && this.canSendOutgoing());
    if (this.cloneConsent) this.startClone();
  }

  createTranslator(s) {
    const common = {
      myLanguage: s.myLanguage,
      theirLanguage: s.theirLanguage,
      meetingContext: s.meetingContext,
      keyterms: parseKeyterms(s.keyterms),
    };
    if (isFreeTranslation(s)) return new FreeTranslator({ ...common, keys: freeKeys(s), log });
    return new Translator({
      ...common,
      apiKey: s.anthropicKey,
      model: s.claudeModel,
      onUsage: (model, usage) => this.usage.addClaude(model, usage),
    });
  }

  async verifyTranslator() {
    const free = this.translator instanceof FreeTranslator;
    try {
      const notes = await this.translator.verify();
      for (const note of notes || []) this.warn(note.id, note.key, note.params);
    } catch (err) {
      throw new UserError(describeClaudeError(err), free ? 'free-translation' : 'anthropic');
    }
  }

  async resolveVoices() {
    const s = this.settings;
    this.myVoiceId = s.myVoiceId;
    this.theirVoiceId = s.theirVoiceId;
    let voices;
    try {
      voices = await listVoices(s.elevenLabsKey);
    } catch (err) {
      throw new UserError(describeElevenLabsError(err), 'elevenlabs');
    }
    const exists = (id) => voices.some((v) => v.voice_id === id);
    const premade = voices.filter((v) => v.category === 'premade');
    const pool = premade.length ? premade : voices;
    if (!pool.length) throw new UserError(t('err.noVoices'), 'voices');
    if (!this.myVoiceId || !exists(this.myVoiceId)) {
      this.myVoiceId = pool[0].voice_id;
      this.warn('my-voice', 'warn.myVoice');
    }
    if (!this.theirVoiceId || !exists(this.theirVoiceId)) this.theirVoiceId = (pool[1] || pool[0]).voice_id;
  }

  createStt(dir, languageCode, keyterms) {
    return new ScribeRealtime({
      name: dir === 'in' ? 'stt-in' : 'stt-out',
      apiKey: this.settings.elevenLabsKey,
      languageCode,
      vadSilenceSecs: this.settings.vadSilenceSecs,
      keyterms,
      onPartial: (text) => this.onPartial(dir, text),
      onCommitted: (text) => this.onCommitted(dir, text),
      onServerMessage: (type, text) => this.debugSink?.event({ kind: 'stt-message', dir, type, text }),
      onStatus: (status) => {
        this.stt[dir] = status;
        this.debugSink?.event({ kind: 'stt', dir, status });
        this.report();
      },
      onFatal: (err, cause) => this.fail(new UserError(describeSttFatal(err, cause), 'stt')),
      log,
    });
  }

  ensureStt(dir, on) {
    const stt = dir === 'in' ? this.sttIn : this.sttOut;
    if (!stt) return;
    if (on && stt.stopped) stt.start();
    else if (!on && !stt.stopped) stt.stop();
    if (!on) this.stt[dir] = 'off';
  }

  // My speech is only listened to when it can actually reach the call: translation to
  // them is on, Meet is sending my microphone, and I am not muted in Meet.
  canSendOutgoing() {
    return this.outgoingMode === 'voice' && Boolean(this.tabPort) && !this.page.muted && this.page.senders > 0;
  }

  onTabChunk(m) {
    this.levels.tab = Math.max(m.rms, this.levels.tab * 0.7);
    if (m.raw && this.collector) this.collectClone(m.raw, m.rawRate, m.rms);
    if (!this.sttIn || this.sttIn.stopped) return;
    this.sttIn.sendAudio(m.pcm);
    this.debugSink?.pcm('in', m.pcm);
    this.usage.addStt(0.1);
  }

  onMicChunk(m) {
    this.levels.mic = Math.max(m.rms, this.levels.mic * 0.7);
    if (!this.sttOut || this.sttOut.stopped) return;
    const open = this.canSendOutgoing() && !(this.settings.halfDuplex && this.localPlayer.playing);
    const pcm = open ? m.pcm : new Int16Array(m.pcm.length);
    this.sttOut.sendAudio(pcm);
    this.debugSink?.pcm('out', pcm);
    this.usage.addStt(0.1);
  }

  // Finished sentences go to translation while the speaker is still talking (see
  // EarlySentences); the live line shows only what has not been sent yet.
  onPartial(dir, text) {
    this.debugSink?.event({ kind: 'partial', dir, text });
    if (dir === 'out' && !this.canSendOutgoing()) return;
    const early = this.early?.[dir];
    const ready = early?.partial(text);
    if (ready) this.translateSegment(dir, ready);
    this.caption(dir, { phase: 'partial', source: early ? early.live(text) : text });
  }

  onCommitted(dir, text) {
    this.debugSink?.event({ kind: 'committed', dir, text });
    if (dir === 'out' && !this.canSendOutgoing()) {
      this.early?.out.reset();
      return;
    }
    const rest = this.early ? this.early[dir].committed(text) : text;
    if (rest && !isOnlyPunctuation(rest)) this.translateSegment(dir, rest);
  }

  translateSegment(dir, text) {
    (dir === 'in' ? this.incoming : this.outgoing)?.onCommitted(text);
  }

  speak(item, dir) {
    const s = this.settings;
    const voiceId = dir === 'in' ? this.theirCloneId || this.theirVoiceId : this.myVoiceId;
    // Speech waiting to play, queued or already in the player: catch up by speaking faster.
    const queued = (dir === 'in' ? this.incoming : this.outgoing)?.speaker.pendingSeconds() || 0;
    const backlog = (dir === 'in' ? this.localPlayer.backlog() : this.page.backlog) + queued;
    const speed = backlog > 5 ? 1.2 : backlog > 2.5 ? 1.1 : 1;
    this.usage.addTts(item.text.length, s.ttsModel);
    return synthesize({
      apiKey: s.elevenLabsKey,
      voiceId,
      text: item.text,
      modelId: s.ttsModel,
      languageCode: dir === 'in' ? s.myLanguage : s.theirLanguage,
      voiceSettings: { stability: s.stability, similarity_boost: s.similarity, speed },
      previousText: item.previousText,
      signal: item.signal,
    });
  }

  localSink() {
    return {
      push: (id, pcm) => this.localPlayer.push(id, pcm),
      end: (id) => this.localPlayer.end(id),
      flush: () => this.localPlayer.flush(),
      backlog: () => this.localPlayer.backlog(),
    };
  }

  remoteSink() {
    return {
      push: (id, pcm) => {
        this.postTab({ type: 'tts', op: 'chunk', id, data: int16ToBase64(pcm) });
        if (this.settings.monitorVolume > 0) this.monitorPlayer.push(id, pcm);
        this.recordSentPlayer?.push(id, pcm);
      },
      end: (id) => {
        this.postTab({ type: 'tts', op: 'end', id });
        this.monitorPlayer.end(id);
        this.recordSentPlayer?.end(id);
      },
      flush: () => {
        this.postTab({ type: 'tts', op: 'flush' });
        this.monitorPlayer.flush();
        this.recordSentPlayer?.flush();
      },
      backlog: () => this.page.backlog,
    };
  }

  onFirstAudio(item) {
    const segment = item.segment;
    if (segment.firstAudioAt) return;
    segment.firstAudioAt = performance.now();
    const ms = Math.round(segment.firstAudioAt - segment.committedAt);
    this.latencies.push(ms);
    if (this.latencies.length > 8) this.latencies.shift();
    log('info', `${segment.id} first audio ${ms} ms after commit`);
  }

  // The translation stays readable; the line only says it could not be spoken.
  onSpeechError(dir, item, err) {
    log('error', `speech ${dir}`, err);
    this.caption(dir, { id: item.segment.id, phase: 'speech-error', error: t('speech.failed', { error: describeElevenLabsError(err) }) });
  }

  caption(dir, event) {
    this.debugSink?.event({ kind: 'caption', dir, ...event });
    this.postTab({ type: 'caption', dir, ...event });
  }

  originalLevel(playing) {
    if (this.incomingMode !== 'voice') return 1;
    return playing ? this.settings.duckVolume : this.settings.originalVolume;
  }

  updateDucking() {
    if (!this.originalGain) return;
    const target = this.originalLevel(this.localPlayer?.playing);
    this.originalGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
  }

  attachTab(port) {
    if (this.tabPort && this.tabPort !== port) {
      try {
        this.tabPort.disconnect();
      } catch {
        // gone already
      }
    }
    this.tabPort = port;
    port.onMessage.addListener((m) => this.onTabMessage(m));
    port.onDisconnect.addListener(() => {
      if (this.tabPort !== port) return;
      this.tabPort = null;
      this.page = { ...this.page, muted: true, senders: 0, backlog: 0 };
      this.outgoing?.flush();
      this.report();
    });
    this.postTab({
      type: 'hello',
      uiLanguage: this.settings.uiLanguage,
      diagnostic: this.diagnostic,
      showOverlay: this.settings.showOverlay,
      myLanguage: this.settings.myLanguage,
      theirLanguage: this.settings.theirLanguage,
      incomingMode: this.incomingMode,
      outgoingMode: this.outgoingMode,
      offerClone: this.settings.offerTheirClone && !this.diagnostic,
      subtitleBar: this.settings.subtitleBar && !this.diagnostic,
      cloneConsent: this.cloneConsent,
    });
    this.syncPageActivation();
    this.postTab({ type: 'clone', clone: this.clone });
    this.report();
  }

  pageShouldSend() {
    return this.diagnostic || this.outgoingMode === 'voice';
  }

  syncPageActivation() {
    this.postTab({ type: this.pageShouldSend() ? 'activate' : 'deactivate' });
  }

  postTab(msg) {
    try {
      this.tabPort?.postMessage(msg);
    } catch {
      // the tab went away; onDisconnect cleans up
    }
  }

  onTabMessage(m) {
    if (m?.type === 'debug-sink') {
      if (!DEBUG_BUILD) return;
      const url = debugSinkUrl(m.port);
      if (url && !this.debugSink) {
        this.debugSink = new DebugSink(url);
        this.debugSink.event({ kind: 'start', settings: { ...this.settings, elevenLabsKey: undefined, anthropicKey: undefined, deeplKey: undefined, mistralKey: undefined, groqKey: undefined }, recording: Boolean(this.recorder) });
        log('info', `debug copies go to ${url}`);
        // A recording that began before this carries its file header in the chunks already saved.
        const rec = this.recording;
        if (rec) {
          Promise.all(rec.writes)
            .then(() => recordingChunks(rec.id))
            .then((chunks) => chunks.forEach((c) => this.debugSink?.recording(c.seq, c.blob)))
            .catch(() => {});
        }
      }
      return;
    }
    if (m?.type === 'page-state') {
      const wasOpen = !this.page.muted && this.page.senders > 0;
      this.page = { ...this.page, ...m.state };
      // Only in a joined call: in the lobby the microphone shows on before any connection.
      const micOnInMeet = m.state.debug?.dom === false;
      if (micOnInMeet && m.state.inCall && !(m.state.senders > 0)) this.unattachedSince ||= Date.now();
      else this.unattachedSince = 0;
      const isOpen = !this.page.muted && this.page.senders > 0;
      if (wasOpen && !isOpen) this.onOutgoingClosed();
      if (!wasOpen && isOpen) this.onOutgoingOpened();
      if (m.state.micLabel) this.followMeetMic(m.state.micLabel);
    } else if (m?.type === 'ui') {
      if (m.action === 'options') this.setOptions(m.options || {});
      else if (m.action === 'chime') this.sendChime();
    }
  }

  // Muted in Meet (or no call yet): drop whatever was queued for them, and after a
  // while close the speech recognition for my side so it costs nothing.
  onOutgoingClosed() {
    this.outgoing?.flush();
    this.early?.out.reset();
    clearTimeout(this.muteTimer);
    this.muteTimer = setTimeout(() => {
      if (!this.canSendOutgoing()) this.ensureStt('out', false);
    }, MUTE_IDLE_MS);
    this.report();
  }

  onOutgoingOpened() {
    clearTimeout(this.muteTimer);
    if (this.outgoingMode === 'voice') this.ensureStt('out', true);
    this.report();
  }

  setOptions(options) {
    if (!this.diagnostic && options.incomingMode && options.incomingMode !== this.incomingMode) {
      this.incomingMode = options.incomingMode;
      this.incoming?.setMode(this.incomingMode);
      this.ensureStt('in', this.incomingMode !== 'off');
      if (this.incomingMode !== 'voice') this.stopCloneCollection();
      else if (this.cloneConsent) this.startClone();
      this.updateDucking();
    }
    if (!this.diagnostic && options.outgoingMode && options.outgoingMode !== this.outgoingMode) {
      this.outgoingMode = options.outgoingMode;
      this.outgoing?.setMode(this.outgoingMode === 'voice' ? 'voice' : 'off');
      this.ensureStt('out', this.outgoingMode === 'voice' && this.canSendOutgoing());
      this.syncPageActivation();
    }
    if (options.cloneConsent !== undefined && Boolean(options.cloneConsent) !== this.cloneConsent) {
      this.cloneConsent = Boolean(options.cloneConsent);
      if (this.cloneConsent) this.startClone();
      else this.stopCloneCollection();
    }
    this.postTab({ type: 'modes', incomingMode: this.incomingMode, outgoingMode: this.outgoingMode, cloneConsent: this.cloneConsent });
    chrome.runtime
      .sendMessage({ type: 'engine-options', options: { incomingMode: this.incomingMode, outgoingMode: this.outgoingMode } })
      .catch(() => {});
    this.report();
  }

  updateSettings(next) {
    const prev = this.settings;
    this.settings = next;
    if (next.uiLanguage !== prev.uiLanguage) {
      setLanguage(next.uiLanguage);
      this.postTab({ type: 'language', uiLanguage: next.uiLanguage });
    }
    this.translationGain?.gain.setTargetAtTime(next.translationVolume, this.ctx.currentTime, 0.05);
    this.monitorGain?.gain.setTargetAtTime(next.monitorVolume, this.ctx.currentTime, 0.05);
    this.updateDucking();
    if (this.translator && isFreeTranslation(next) !== isFreeTranslation(prev) && !missingKeys(next).length) {
      // Switched between Claude and free translation mid-call.
      this.translator = this.createTranslator(next);
      if (this.incoming) this.incoming.translator = this.translator;
      if (this.outgoing) this.outgoing.translator = this.translator;
    } else {
      this.translator?.update({
        model: next.claudeModel,
        meetingContext: next.meetingContext,
        keyterms: parseKeyterms(next.keyterms),
        keys: freeKeys(next),
      });
    }
    if (next.myVoiceId && next.myVoiceId !== prev.myVoiceId) {
      this.myVoiceId = next.myVoiceId;
      this.warnings.delete('my-voice');
    }
    if (next.theirVoiceId && next.theirVoiceId !== prev.theirVoiceId) this.theirVoiceId = next.theirVoiceId;
    if (next.outputDeviceLabel !== prev.outputDeviceLabel) this.applyOutputDevice();
    if (next.micDeviceLabel !== prev.micDeviceLabel) this.openMic().catch((err) => log('warn', 'microphone switch', err));
    if (next.showOverlay !== prev.showOverlay) this.postTab({ type: 'overlay', show: next.showOverlay });
    if (next.subtitleBar !== prev.subtitleBar) this.postTab({ type: 'subtitles', show: next.subtitleBar && !this.diagnostic });
    this.report();
  }

  startClone() {
    if (this.diagnostic || this.incomingMode !== 'voice' || this.theirCloneId || this.collector) return;
    if (!this.settings.offerTheirClone || this.clone.state === 'creating') return;
    this.collector = new CloneCollector({ targetSeconds: this.settings.cloneSeconds });
    this.tabNode.port.postMessage({ type: 'collect-raw', on: true });
    this.clone = { state: 'collecting', seconds: 0, target: this.settings.cloneSeconds };
    this.postTab({ type: 'clone', clone: this.clone });
  }

  stopCloneCollection() {
    if (!this.collector) return;
    this.collector = null;
    this.tabNode?.port.postMessage({ type: 'collect-raw', on: false });
    this.clone = { state: 'off' };
    this.postTab({ type: 'clone', clone: this.clone });
  }

  collectClone(raw, rate, level) {
    const full = this.collector.push(raw, rate, level);
    const seconds = Math.floor(this.collector.seconds());
    if (seconds !== this.clone.seconds) {
      this.clone = { ...this.clone, seconds };
      this.postTab({ type: 'clone', clone: this.clone });
    }
    if (full) this.finishClone();
  }

  async finishClone() {
    const collector = this.collector;
    this.collector = null;
    this.tabNode.port.postMessage({ type: 'collect-raw', on: false });
    this.clone = { state: 'creating' };
    this.postTab({ type: 'clone', clone: this.clone });
    try {
      const stamp = new Date().toLocaleString(locale());
      const result = await createVoiceClone(this.settings.elevenLabsKey, {
        name: t('clone.name', { stamp }),
        files: [{ blob: collector.toWavBlob(), filename: 'meet-sample.wav' }],
        description: "Instant clone made by Meet Interpreter during a call, with the participant's consent.",
      });
      if (this.stopped) {
        if (this.settings.deleteCloneAfter) deleteVoice(this.settings.elevenLabsKey, result.voice_id).catch(() => {});
        return;
      }
      this.theirCloneId = result.voice_id;
      this.clone = { state: 'ready' };
    } catch (err) {
      log('error', 'voice clone', err);
      this.clone = { state: 'failed', error: describeElevenLabsError(err) };
    }
    this.postTab({ type: 'clone', clone: this.clone });
    this.report();
  }

  // Connection test: a short chime into the call (only heard there while Meet is
  // sending my microphone) and, quieter, on my own speakers.
  sendChime() {
    const pcm = testChime();
    const id = `chime-${Date.now()}`;
    this.postTab({ type: 'tts', op: 'chunk', id, data: int16ToBase64(pcm) });
    this.postTab({ type: 'tts', op: 'end', id });
    const quiet = pcm.map((v) => Math.round(v * 0.4));
    this.localPlayer.push(id, quiet);
    this.localPlayer.end(id);
  }

  // Warnings keep their i18n key, so they follow a language change made mid-call.
  warn(id, key, params) {
    this.warnings.set(id, { key, params });
  }

  status() {
    const latency = this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null;
    return {
      tabId: this.tabId,
      diagnostic: this.diagnostic,
      incomingMode: this.incomingMode,
      outgoingMode: this.outgoingMode,
      cloneConsent: this.cloneConsent,
      recording: this.recorder?.state === 'recording',
      debugCopies: Boolean(this.debugSink),
      stt: { ...this.stt },
      page: {
        connected: Boolean(this.tabPort),
        muted: this.page.muted,
        senders: this.page.senders,
        ctxState: this.page.ctxState,
        // Meet shows the microphone on, yet the translation track is not on any sender.
        unattached: this.outgoingMode === 'voice' && Boolean(this.unattachedSince) && Date.now() - this.unattachedSince > 8000,
      },
      sendingToCall: this.canSendOutgoing(),
      levels: { tab: Number(this.levels.tab.toFixed(3)), mic: Number(this.levels.mic.toFixed(3)) },
      micLabel: this.micLabel || '',
      clone: this.clone,
      latencyMs: latency,
      usage: this.usage.snapshot(),
      warnings: [...this.warnings.values()].map((w) => t(w.key, w.params)),
      error: this.error,
    };
  }

  report() {
    if (this.stopped) return;
    const status = this.status();
    chrome.runtime.sendMessage({ type: 'engine-status', status }).catch(() => {});
    this.postTab({ type: 'status', status });
    this.levels.tab *= 0.5;
    this.levels.mic *= 0.5;
  }

  fail(err) {
    if (this.stopped || this.error) return;
    this.error = err.message;
    log('error', err);
    this.report();
    chrome.runtime.sendMessage({ type: 'engine-failed', error: err.message, code: err.code }).catch(() => {});
  }

  // Records the Meet tab's picture with everything heard on this side (the other
  // person, the translation, my own voice) and everything sent to them, into the
  // extension's IndexedDB on this computer (see shared/recordings.js).
  startRecording() {
    const ctx = this.ctx;
    this.recordDest = ctx.createMediaStreamDestination();
    // Their own voice goes into the recording whatever the listening level is.
    this.recordOriginalGain = ctx.createGain();
    this.recordOriginalGain.gain.value = 0.6;
    this.tabSource.connect(this.recordOriginalGain).connect(this.recordDest);
    this.translationGain.connect(this.recordDest);
    this.recordMicGain = ctx.createGain();
    this.recordMicGain.gain.value = 0.8;
    this.recordMicGain.connect(this.recordDest);
    this.micSource?.connect(this.recordMicGain);
    const sentGain = ctx.createGain();
    sentGain.connect(this.recordDest);
    this.recordSentPlayer = new PcmScheduler(ctx, sentGain);

    const tracks = [...this.tabStream.getVideoTracks(), ...this.recordDest.stream.getAudioTracks()];
    // MP4 first: it plays in QuickTime on a Mac; WebM where MP4 recording is missing.
    const mimeType = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    this.recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    const rec = { id: `rec-${Date.now()}`, startedAt: Date.now(), mimeType: this.recorder.mimeType || mimeType, seq: 0, bytes: 0, writes: [] };
    this.recording = rec;
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      rec.bytes += event.data.size;
      this.debugSink?.recording(rec.seq, event.data);
      rec.writes.push(saveChunk(rec.id, rec.seq++, event.data).catch((err) => log('error', 'recording chunk', err)));
    };
    this.recorder.start(2000);
    saveRecording({ id: rec.id, startedAt: rec.startedAt, endedAt: null, mimeType: rec.mimeType, chunks: 0, bytes: 0 }).catch(() => {});
    log('info', `recording ${rec.id} (${rec.mimeType})`);
  }

  async finishRecording() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return null;
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    });
    const rec = this.recording;
    await Promise.all(rec.writes);
    const meta = { id: rec.id, startedAt: rec.startedAt, endedAt: Date.now(), mimeType: rec.mimeType, chunks: rec.seq, bytes: rec.bytes };
    await saveRecording(meta);
    return meta;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const recording = await this.finishRecording().catch((err) => {
      log('error', 'recording', err);
      return null;
    });
    clearInterval(this.statusTimer);
    clearTimeout(this.muteTimer);
    this.debugSink?.close();
    this.incoming?.flush();
    this.outgoing?.flush();
    this.sttIn?.stop();
    this.sttOut?.stop();
    this.postTab({ type: 'deactivate', final: true });
    try {
      this.tabPort?.disconnect();
    } catch {
      // already gone
    }
    this.tabPort = null;
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.tabStream?.getTracks().forEach((t) => t.stop());
    this.localPlayer?.flush();
    this.monitorPlayer?.flush();
    await this.ctx?.close().catch(() => {});
    if (this.theirCloneId && this.settings.deleteCloneAfter) {
      await withTimeout(deleteVoice(this.settings.elevenLabsKey, this.theirCloneId), 4000).catch((err) => log('warn', 'clone delete', err));
    }
    if (recording) chrome.runtime.sendMessage({ type: 'recording-ready', id: recording.id }).catch(() => {});
  }
}
