// Runs in Meet's own JavaScript world from the first moment the page loads, so it can
// see the RTCRtpSender that carries the microphone into the call.
//
// While translation to the counterpart is on, that sender carries a track we make
// instead (our AudioContext, fed with the translated speech), and Meet keeps seeing
// its own microphone track everywhere it looks (sender.track is reported as Meet's).
// Turning it off puts Meet's track back. Nothing here talks to the network: the
// audio arrives from the extension through a private MessagePort.

import { PcmScheduler } from '../shared/scheduler.js';
import { base64ToInt16 } from '../shared/pcm.js';

(() => {
  const FLAG = '__meetTercumanHook';
  if (window[FLAG] || !window.RTCPeerConnection || !window.RTCRtpSender) return;
  Object.defineProperty(window, FLAG, { value: true });

  const senderProto = RTCRtpSender.prototype;
  const pcProto = RTCPeerConnection.prototype;
  const trackProto = MediaStreamTrack.prototype;
  const nativeReplaceTrack = senderProto.replaceTrack;
  const nativeAddTrack = pcProto.addTrack;
  const nativeAddTransceiver = pcProto.addTransceiver;
  const nativeSenderTrack = Object.getOwnPropertyDescriptor(senderProto, 'track').get;
  const enabledDescriptor = Object.getOwnPropertyDescriptor(trackProto, 'enabled');
  const nativeStop = trackProto.stop;
  const isEnabled = (track) => enabledDescriptor.get.call(track);
  const setEnabled = (track, value) => enabledDescriptor.set.call(track, value);

  const audioSenders = new Set(); // senders carrying Meet's microphone
  const audioKind = new WeakSet(); // senders made with addTransceiver('audio'), track set later
  const meetTrack = new WeakMap(); // sender -> the track Meet believes it set
  const swapped = new Set(); // senders currently carrying our track
  const rawTracks = []; // microphone tracks Meet got from getUserMedia
  const peers = new Set(); // Meet's peer connections: a connected one means the call has begun

  let port = null;
  let active = false;
  let audio = null;
  let lastState = '';
  let mutedNow = true;
  let postTimer = null;
  let pollTimer = null;

  // ---- audio we send into the call -------------------------------------------------

  function ensureAudio() {
    if (audio) return audio;
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.channelCountMode = 'explicit';
    const gain = ctx.createGain();
    gain.connect(destination);
    const track = destination.stream.getAudioTracks()[0];
    const player = new PcmScheduler(ctx, gain, { onPlayingChange: () => schedulePost() });
    audio = { ctx, track, player };
    resumeAudio();
    return audio;
  }

  // The page has normally been clicked already (joining a call needs a click); if not,
  // the first click or key press anywhere starts our audio.
  function resumeAudio() {
    if (audio && audio.ctx.state === 'suspended') audio.ctx.resume().then(schedulePost, () => {});
  }
  window.addEventListener('pointerdown', resumeAudio, { capture: true, passive: true });
  window.addEventListener('keydown', resumeAudio, { capture: true, passive: true });

  // ---- swapping the microphone sender ----------------------------------------------

  function swap(sender) {
    if (!audio || swapped.has(sender) || !meetTrack.get(sender)) return;
    swapped.add(sender);
    nativeReplaceTrack.call(sender, audio.track).catch((err) => {
      swapped.delete(sender);
      console.warn('[tercuman] could not attach the translation track', err);
      schedulePost();
    });
  }

  function unswap(sender) {
    if (!swapped.delete(sender)) return;
    nativeReplaceTrack.call(sender, meetTrack.get(sender) ?? null).catch(() => {});
  }

  function prune() {
    for (const pc of peers) if (pc.connectionState === 'closed') peers.delete(pc);
    for (const sender of audioSenders) {
      if (sender.transport?.state === 'closed') {
        audioSenders.delete(sender);
        swapped.delete(sender);
      }
    }
  }

  function adopt(sender, track) {
    meetTrack.set(sender, track);
    audioSenders.add(sender);
    if (active) swap(sender);
    schedulePost();
  }

  function activate() {
    ensureAudio();
    resumeAudio();
    active = true;
    prune();
    for (const sender of audioSenders) swap(sender);
    if (!pollTimer) pollTimer = setInterval(() => postState(), 300);
    schedulePost();
  }

  function deactivate(final) {
    active = false;
    for (const sender of [...swapped]) unswap(sender);
    if (audio) {
      audio.player.flush();
      if (final) {
        audio.ctx.close().catch(() => {});
        audio = null;
      }
    }
    if (final && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    schedulePost();
  }

  pcProto.addTrack = function addTrack(track, ...streams) {
    peers.add(this);
    const sender = nativeAddTrack.call(this, track, ...streams);
    if (track && track.kind === 'audio' && track !== audio?.track) adopt(sender, track);
    return sender;
  };

  pcProto.addTransceiver = function addTransceiver(...args) {
    peers.add(this);
    const transceiver = nativeAddTransceiver.apply(this, args);
    const trackOrKind = args[0];
    if (trackOrKind instanceof MediaStreamTrack) {
      if (trackOrKind.kind === 'audio' && trackOrKind !== audio?.track) adopt(transceiver.sender, trackOrKind);
    } else if (trackOrKind === 'audio') {
      audioKind.add(transceiver.sender);
    }
    return transceiver;
  };

  // The legacy stream API, in case Meet ever falls back to it.
  if (typeof pcProto.addStream === 'function') {
    const nativeAddStream = pcProto.addStream;
    pcProto.addStream = function addStream(stream) {
      const result = nativeAddStream.call(this, stream);
      const tracks = new Set(stream.getAudioTracks());
      for (const sender of this.getSenders()) {
        const track = nativeSenderTrack.call(sender);
        if (track && tracks.has(track)) adopt(sender, track);
      }
      return result;
    };
  }

  senderProto.replaceTrack = function replaceTrack(track) {
    if (audio && track === audio.track) return nativeReplaceTrack.call(this, track);
    const known = audioSenders.has(this) || audioKind.has(this);
    if ((track && track.kind === 'audio') || (track === null && known)) {
      meetTrack.set(this, track);
      audioSenders.add(this);
      schedulePost();
      if (active && track) {
        swapped.add(this);
        return nativeReplaceTrack.call(this, audio.track);
      }
      swapped.delete(this);
    }
    return nativeReplaceTrack.call(this, track);
  };

  // Meet keeps seeing its own track on the sender, so its UI and checks are unaffected.
  Object.defineProperty(senderProto, 'track', {
    configurable: true,
    enumerable: true,
    get() {
      return swapped.has(this) ? (meetTrack.get(this) ?? null) : nativeSenderTrack.call(this);
    },
  });

  // Mute and unmute show up as a change of `enabled` or as a stopped track.
  Object.defineProperty(trackProto, 'enabled', {
    configurable: true,
    enumerable: true,
    get() {
      return isEnabled(this);
    },
    set(value) {
      setEnabled(this, value);
      if (this.kind === 'audio') schedulePost();
    },
  });

  trackProto.stop = function stop() {
    nativeStop.call(this);
    if (this.kind === 'audio') schedulePost();
  };

  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices?.getUserMedia) {
    const nativeGetUserMedia = mediaDevices.getUserMedia;
    mediaDevices.getUserMedia = function getUserMedia(constraints) {
      return nativeGetUserMedia.call(this, constraints).then((stream) => {
        for (const track of stream.getAudioTracks()) {
          rawTracks.push(track);
          track.addEventListener('ended', schedulePost);
          while (rawTracks.length > 8) rawTracks.shift();
        }
        schedulePost();
        return stream;
      });
    };
  }

  // ---- is Meet sending my microphone right now? -------------------------------------

  function labelOf(el) {
    const parts = [];
    for (const node of [el, el.querySelector('button, [role="button"]')]) {
      if (!node) continue;
      parts.push(node.getAttribute('aria-label') || '', node.getAttribute('data-tooltip') || '');
    }
    return parts.join(' ');
  }

  // Meet's microphone button carries data-is-muted. Its label used to name the shortcut
  // (ctrl/cmd + d) in every UI language; now only its tooltip does (October 2026), so the
  // word for microphone tells it apart from the camera button.
  const MIC_WORD = /micr|mikr|микр|μικρ|ميكروفون|माइक|マイク|麦克风|麥克風|마이크/i;
  function domMuted() {
    const candidates = document.querySelectorAll('[data-is-muted]');
    let fallback = null;
    for (const el of candidates) {
      const label = labelOf(el);
      if (/\+\s*d\b/i.test(label)) return el.getAttribute('data-is-muted') === 'true';
      if (fallback === null && MIC_WORD.test(label)) fallback = el.getAttribute('data-is-muted') === 'true';
    }
    return fallback;
  }

  function computeState() {
    prune();
    let sending = false;
    for (const sender of audioSenders) {
      const track = meetTrack.get(sender);
      if (track && track.readyState === 'live' && isEnabled(track)) sending = true;
    }
    const liveRaw = rawTracks.filter((t) => t.readyState === 'live');
    const rawState = rawTracks.length === 0 ? 'none' : liveRaw.some((t) => isEnabled(t)) ? 'live' : 'off';
    const dom = domMuted();
    const muted = dom !== null ? dom || !sending : !sending || rawState === 'off';
    const micTrack = liveRaw[liveRaw.length - 1];
    return {
      muted,
      senders: swapped.size,
      inCall: [...peers].some((pc) => pc.connectionState === 'connected'),
      micLabel: micTrack?.label || '',
      ctxState: audio ? audio.ctx.state : 'none',
      backlog: audio ? Number(audio.player.backlog().toFixed(2)) : 0,
      playing: audio ? audio.player.playing : false,
      debug: { dom, sending, rawState, audioSenders: audioSenders.size },
    };
  }

  function postState(force) {
    const state = computeState();
    mutedNow = state.muted;
    // While muted nothing translated may reach the call, not even what is queued.
    if (audio) {
      const allow = active && !state.muted;
      if (isEnabled(audio.track) !== allow) setEnabled(audio.track, allow);
      if (!allow && audio.player.playing) audio.player.flush();
    }
    const json = JSON.stringify(state);
    if (!force && json === lastState) return;
    lastState = json;
    port?.postMessage({ type: 'page-state', state });
  }

  function schedulePost() {
    if (postTimer) return;
    postTimer = setTimeout(() => {
      postTimer = null;
      postState();
    }, 40);
  }

  // ---- private channel to the content script ----------------------------------------

  function onCommand(msg) {
    switch (msg?.type) {
      case 'activate':
        activate();
        break;
      case 'deactivate':
        deactivate(Boolean(msg.final));
        break;
      case 'tts':
        if (!audio) return;
        if (msg.op === 'chunk') {
          if (active && !mutedNow) audio.player.push(msg.id, base64ToInt16(msg.data));
        } else if (msg.op === 'end') {
          audio.player.end(msg.id);
        } else if (msg.op === 'flush') {
          audio.player.flush();
        }
        schedulePost();
        break;
      case 'probe':
        postState(true);
        break;
      default:
        break;
    }
  }

  // The content script hands over a MessagePort; only the first one is accepted, and
  // it arrives before any of Meet's scripts run. Meet's own message listeners never
  // see it, and audio never travels through window messages.
  window.addEventListener(
    'message',
    (event) => {
      if (port || event.source !== window || event.data?.__meetTercuman !== 'port' || !event.ports?.[0]) return;
      event.stopImmediatePropagation();
      port = event.ports[0];
      port.onmessage = (e) => onCommand(e.data);
      port.postMessage({ type: 'hello' });
      postState(true);
    },
    true,
  );
  document.dispatchEvent(new CustomEvent('meet-tercuman-hook-ready'));
})();
