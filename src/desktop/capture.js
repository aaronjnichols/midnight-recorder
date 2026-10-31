let recorder, streams = [], audioContext, frame, queue = Promise.resolve(), chunkError;

async function cleanup() {
  clearInterval(frame);
  streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
  streams = [];
  if (audioContext) await audioContext.close();
  audioContext = null;
}

async function videoElement(stream) {
  const element = document.createElement('video');
  element.muted = true; element.srcObject = stream;
  await element.play();
  return element;
}

async function start(options) {
  queue = Promise.resolve(); chunkError = null;
  let screenStream, cameraStream;
  const fps = options.frameRate || 30;
  try {
    if (!options.cameraOnly) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: !!options.systemAudio });
      streams.push(screenStream);
    }
    if (options.cameraId || options.cameraOnly) {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: options.cameraId && options.cameraId !== 'default' ? { deviceId: { exact: options.cameraId } } : true, audio: false });
      streams.push(cameraStream);
    }
    const output = new MediaStream();
    {
      const screen = await videoElement(screenStream || cameraStream);
      const camera = screenStream && cameraStream ? await videoElement(cameraStream) : null;
      const canvas = document.createElement('canvas');
      canvas.width = screen.videoWidth; canvas.height = screen.videoHeight;
      const context = canvas.getContext('2d');
      const draw = () => {
        context.drawImage(screen, 0, 0, canvas.width, canvas.height);
        if (camera) {
        const radius = Math.min(canvas.width, canvas.height) * 0.13;
        const x = canvas.width - radius - 24, y = canvas.height - radius - 24;
        context.save(); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.clip();
        const side = Math.min(camera.videoWidth, camera.videoHeight);
        context.drawImage(camera, (camera.videoWidth - side) / 2, (camera.videoHeight - side) / 2, side, side, x - radius, y - radius, radius * 2, radius * 2);
        context.restore();
        }
      };
      draw();
      frame = setInterval(draw, 1000 / fps);
      const composed = canvas.captureStream(fps); streams.push(composed);
      output.addTrack(composed.getVideoTracks()[0]);
    }
    if (options.microphoneId) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: options.microphoneId === 'default' ? true : { deviceId: { exact: options.microphoneId } }, video: false });
      streams.push(mic);
    }
    const audioStreams = streams.filter(stream => stream.getAudioTracks().length);
    if (audioStreams.length) {
      audioContext = new AudioContext(); await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      audioStreams.forEach(stream => audioContext.createMediaStreamSource(stream).connect(destination));
      output.addTrack(destination.stream.getAudioTracks()[0]);
    }
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: 6000000 });
    recorder.ondataavailable = event => {
      if (event.data.size) queue = queue.then(async () => window.captureBridge.chunk(await event.data.arrayBuffer())).catch(error => { chunkError = error; });
    };
    recorder.start(1000);
    return { mimeType };
  } catch (error) { await cleanup(); throw error; }
}

async function stop() {
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = event => reject(new Error(event.error?.message || 'Recording failed.'));
      recorder.stop();
    });
  }
  await queue;
  await cleanup();
  if (chunkError) throw chunkError;
  return {};
}

window.captureBridge.listen(async ({ id, action, args }) => {
  try {
    let result = {};
    if (action === 'devices') result = (await navigator.mediaDevices.enumerateDevices()).filter(d => ['audioinput', 'videoinput'].includes(d.kind)).map(d => ({ id: d.deviceId, kind: d.kind, name: d.label || (d.kind === 'audioinput' ? 'Microphone' : 'Camera') }));
    if (action === 'start') result = await start(args);
    if (action === 'pause') recorder.pause();
    if (action === 'resume') recorder.resume();
    if (action === 'stop' || action === 'cancel') result = await stop();
    window.captureBridge.reply({ id, result });
  } catch (error) { window.captureBridge.reply({ id, error: error.message }); }
});
